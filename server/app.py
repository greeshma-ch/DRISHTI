"""Drishti server — FastAPI application."""

from __future__ import annotations

import time
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .meta_client import analyze_frame, get_total_spend

app = FastAPI(title="Drishti", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


SPEND_LOG = Path("eval/spend.jsonl")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
    }
