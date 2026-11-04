"""Pydantic settings, reading from .env at the repo root."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    MODEL_API_KEY: str = ""
    META_BASE_URL: str = "https://api.meta.ai/v1"
    SPARK_MODEL: str = "muse-spark-1.3"
    SAM_MODEL: str = "sam-3.1"
    TELEGRAM_BOT_TOKEN: str = ""
    FINAL_RUN: bool = False
    # P4 settings
    CIRCUIT_BREAKER_TIMEOUT: float = 8.0
    CIRCUIT_BREAKER_THRESHOLD: int = 3
    CIRCUIT_BREAKER_OPEN_DURATION: float = 30.0
    RATE_LIMIT_FRAME_RATE: float = 1.2
    RATE_LIMIT_FRAME_BURST: int = 3
    RATE_LIMIT_CHAT_RATE: float = 10 / 60  # per second
    RATE_LIMIT_CHAT_BURST: int = 10
    RATE_LIMIT_GEOCODE_RATE: float = 1.0
    RATE_LIMIT_GEOCODE_BURST: int = 1
    TIER2_CONFIDENCE_THRESHOLD: float = 0.6

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
