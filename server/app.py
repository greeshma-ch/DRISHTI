"""Drishti server — FastAPI application."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import router as auth_router
from .config import settings
from .emergency import router as emergency_router
from .meta_client import analyze_frame, get_perception_stats, get_total_spend, load_prices
from .rate_limiter import RateLimiter, get_rate_limiter, init_rate_limiter
from .telegram_link import router as telegram_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Drishti", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth_router)
app.include_router(emergency_router)
app.include_router(telegram_router)


# Initialize rate limiter at startup
SPEND_LOG = Path("eval/spend.jsonl")


@app.on_event("startup")
async def startup_event() -> None:
    """Initialize rate limiter and load spend total on startup."""
    init_rate_limiter()
    # Load spend total into memory (meta_client.get_total_spend does this lazily)
    get_total_spend()


@app.get("/health")
async def health() -> dict[str, object]:
    from .config import settings

    telegram_configured = bool(
        settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_BOT_TOKEN != "changeme"
    )
    return {
        "status": "ok",
        "dry_run": getattr(settings, "EMERGENCY_DRY_RUN", False),
        "telegram_configured": telegram_configured,
    }


@app.get("/spend")
async def spend() -> dict[str, object]:
    total = get_total_spend(SPEND_LOG)
    records = 0
    if SPEND_LOG.exists():
        lines = SPEND_LOG.read_text(encoding="utf-8").splitlines()
        records = sum(1 for line in lines if line.strip())

    if total < 60:
        level = "normal"
    elif total < 90:
        level = "warn"
    elif total < 120:
        level = "throttle"
    else:
        level = "blocked"

    prices = load_prices()

    return {
        "total_usd": round(total, 4),
        "records": records,
        "level": level,
        "final_run": settings.FINAL_RUN,
        "prices_used": prices,
    }


@app.get("/status")
async def server_status() -> dict[str, object]:
    stats = get_perception_stats()
    spend_data = await spend()
    return {
        "status": "ok",
        "retries": stats["retry_frames"],
        "total_frames": stats["total_frames"],
        "retries_display": stats["retries_display"],
        "retry_ratio": stats["retry_ratio"],
        "retry_percent": stats["retry_percent"],
        "median_reasoning_tokens": stats["median_reasoning_tokens"],
        "spend": spend_data,
    }


def _get_user_id(request: Request) -> str:
    """Extract user ID from X-User-Id header, fallback to client IP."""
    user_id = request.headers.get("X-User-Id")
    if user_id:
        return user_id
    # Fallback to client IP
    client = request.client
    if client:
        return client.host
    return "unknown"


@app.post("/frame")
async def process_frame(
    request: Request,
    file: UploadFile = File(...),
    timestamp: float = Form(...),
    lang: str = Form("en"),
) -> dict[str, object]:
    # Rate limiter check - consume token on every request (use async version)
    rate_limiter: RateLimiter = get_rate_limiter()
    # Ensure rate limiter is initialized (startup event may not run in tests)
    if rate_limiter.db_path is None:
        from .rate_limiter import init_rate_limiter
        init_rate_limiter()
        rate_limiter = get_rate_limiter()
    user_id = _get_user_id(request)
    logger.info("Rate limiter check for user_id=%s, endpoint=frame", user_id)
    allowed, retry_after = await rate_limiter._async_consume(user_id, "frame", 1)
    logger.info("Rate limiter result: allowed=%s, retry_after=%s", allowed, retry_after)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "status": "degraded",
                "reason": "rate_limited",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    t_start = time.perf_counter()
    image_bytes = await file.read()
    result, usage, latency_ms, _ = await analyze_frame(image_bytes, lang=lang)
    server_total_ms = round((time.perf_counter() - t_start) * 1000, 1)

    # Build response with degraded format if needed
    response = {
        "perception": result.model_dump(),
        "usage": usage,
        "latency_ms": latency_ms,
        "client_timestamp": timestamp,
        "server_total_ms": server_total_ms,
        "meta_ms": latency_ms,
        "finish_reason": usage.get("finish_reason", "stop"),
        "retries_display": usage.get("retries_display", "0 / 0"),
        "median_reasoning_tokens": usage.get("median_reasoning_tokens", 0.0),
    }

    return response
