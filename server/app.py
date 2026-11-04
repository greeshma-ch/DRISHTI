"""Drishti server — FastAPI application."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .auth import router as auth_router
from .config import settings
from .emergency import router as emergency_router
from .meta_client import analyze_frame, get_perception_stats, get_total_spend
from .telegram_link import router as telegram_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

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


SPEND_LOG = Path("eval/spend.jsonl")


@app.get("/health")
async def health() -> dict[str, object]:
    from .config import settings

    telegram_configured = bool(
        settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_BOT_TOKEN != "changeme"
    )
    return {
        "status": "ok",
        "dry_run": settings.EMERGENCY_DRY_RUN,
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

    return {
        "total_usd": round(total, 4),
        "records": records,
        "level": level,
        "final_run": settings.FINAL_RUN,
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


@app.post("/frame")
async def process_frame(
    file: UploadFile = File(...),
    timestamp: float = Form(...),
    lang: str = Form("en"),
) -> dict[str, object]:
    t_start = time.perf_counter()
    image_bytes = await file.read()
    result, usage, latency_ms, _ = await analyze_frame(image_bytes, lang=lang)
    server_total_ms = round((time.perf_counter() - t_start) * 1000, 1)

    return {
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
