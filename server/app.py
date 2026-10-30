"""Drishti server — FastAPI application."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings

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
    total = 0.0
    records = 0
    if SPEND_LOG.exists():
        for line in SPEND_LOG.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                total += float(row.get("est_cost_usd", 0))
                records += 1

    # Throttle levels from AGENTS.md
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
