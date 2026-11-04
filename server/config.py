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

    # Emergency (P6)
    EMERGENCY_HMAC_SECRET: str = ""
    EMERGENCY_DRY_RUN: bool = False

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Startup validation for emergency HMAC secret
        if not self.EMERGENCY_DRY_RUN:
            if not self.EMERGENCY_HMAC_SECRET or self.EMERGENCY_HMAC_SECRET == "changeme":
                raise RuntimeError(
                    "EMERGENCY_HMAC_SECRET must be set in .env (not default/empty) "
                    "when EMERGENCY_DRY_RUN=false"
                )


settings = Settings()
