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

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
