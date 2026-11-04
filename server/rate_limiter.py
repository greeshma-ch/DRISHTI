"""Token Bucket Rate Limiter with SQLite persistence (P4).

Uses stdlib sqlite3 with WAL mode.
Persists to eval/rate_limits.sqlite (gitignored).
Prunes rows older than 24h at startup.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .config import settings

logger = logging.getLogger(__name__)

DB_PATH = Path("eval/rate_limits.sqlite")
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Endpoint configs from settings
ENDPOINT_CONFIG = {
    "frame": {
        "rate": settings.RATE_LIMIT_FRAME_RATE,  # tokens per second
        "burst": settings.RATE_LIMIT_FRAME_BURST,
    },
    "chat": {
        "rate": settings.RATE_LIMIT_CHAT_RATE,
        "burst": settings.RATE_LIMIT_CHAT_BURST,
    },
    "geocode": {
        "rate": settings.RATE_LIMIT_GEOCODE_RATE,
        "burst": settings.RATE_LIMIT_GEOCODE_BURST,
        "global": True,  # Global limit (shared across all users)
    },
}

# Exempt endpoints (no rate limiting)
EXEMPT_ENDPOINTS = {"emergency", "health", "status", "spend"}

# Global endpoint user ID
GLOBAL_USER_ID = "__global__"


class RateLimiter:
    """Thread-safe token bucket rate limiter with SQLite persistence.

    Uses a single SQLite connection with a lock for thread safety.
    This avoids WAL visibility issues across multiple connections in different threads.
    """

    def __init__(self, db_path: Path | str = DB_PATH):
        self.db_path = Path(db_path)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._init_db()

    def _init_db(self) -> None:
        """Initialize SQLite database with WAL mode and prune old entries."""
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS rate_limits (
                user_id TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                tokens REAL NOT NULL,
                last_refill REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (user_id, endpoint)
            )
        """)
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_updated_at ON rate_limits(updated_at)")
        self._conn.commit()

        # Prune rows older than 24h
        self._prune_old_entries()

    def _get_conn(self) -> sqlite3.Connection:
        """Get the shared connection."""
        if self._conn is None:
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
        return self._conn

    def _prune_old_entries(self) -> None:
        """Delete rows older than 24 hours."""
        cutoff = time.time() - 86400  # 24 hours
        with self._lock:
            conn = self._get_conn()
            conn.execute("DELETE FROM rate_limits WHERE updated_at < ?", (cutoff,))
            conn.commit()
            deleted = conn.total_changes
            if deleted:
                logger.info("Rate limiter: pruned %d entries older than 24h", deleted)

    async def _async_consume(self, user_id: str, endpoint: str, tokens_to_consume: int) -> tuple[bool, int]:
        """Async version of consume - atomic read-modify-write using shared connection."""
        config = ENDPOINT_CONFIG[endpoint]
        burst = config["burst"]
        rate = config["rate"]
        is_global = config.get("global", False)
        bucket_user_id = GLOBAL_USER_ID if is_global else user_id

        def _consume_atomic():
            with self._lock:
                conn = self._get_conn()
                # Read current state
                cursor = conn.execute(
                    "SELECT tokens, last_refill FROM rate_limits WHERE user_id = ? AND endpoint = ?",
                    (bucket_user_id, endpoint),
                )
                row = cursor.fetchone()
                now = time.time()
                if row:
                    tokens, last_refill = row
                    elapsed = now - last_refill
                    tokens = min(burst, tokens + elapsed * rate)
                else:
                    tokens = float(burst)

                if tokens >= tokens_to_consume:
                    tokens -= tokens_to_consume
                    conn.execute(
                        """
                        INSERT INTO rate_limits (user_id, endpoint, tokens, last_refill, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, endpoint) DO UPDATE SET
                            tokens = excluded.tokens,
                            last_refill = excluded.last_refill,
                            updated_at = excluded.updated_at
                        """,
                        (bucket_user_id, endpoint, tokens, now, now),
                    )
                    conn.commit()
                    return True, 0
                else:
                    retry_after = int((tokens_to_consume - tokens) / rate) + 1
                    return False, retry_after

        return await asyncio.to_thread(_consume_atomic)

    async def _async_check_limit(self, user_id: str, endpoint: str) -> tuple[bool, int]:
        """Async version of check_limit."""
        config = ENDPOINT_CONFIG[endpoint]
        burst = config["burst"]
        rate = config["rate"]
        is_global = config.get("global", False)
        bucket_user_id = GLOBAL_USER_ID if is_global else user_id

        def _check():
            with self._lock:
                conn = self._get_conn()
                cursor = conn.execute(
                    "SELECT tokens, last_refill FROM rate_limits WHERE user_id = ? AND endpoint = ?",
                    (bucket_user_id, endpoint),
                )
                row = cursor.fetchone()
                now = time.time()
                if row:
                    tokens, last_refill = row
                    elapsed = now - last_refill
                    tokens = min(burst, tokens + elapsed * rate)
                else:
                    tokens = float(burst)

                if tokens >= 1:
                    return True, 0
                else:
                    retry_after = int((1 - tokens) / rate) + 1
                    return False, retry_after

        return await asyncio.to_thread(_check)

    def close(self) -> None:
        """Shutdown - close the shared connection."""
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # Sync wrappers for backward compatibility with tests
    def consume(self, user_id: str, endpoint: str, tokens_to_consume: int = 1) -> tuple[bool, int]:
        """Sync wrapper for consume."""
        if endpoint in EXEMPT_ENDPOINTS:
            return True, 0
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(asyncio.run, self._async_consume(user_id, endpoint, tokens_to_consume))
            return future.result()

    def check_limit(self, user_id: str, endpoint: str) -> tuple[bool, int]:
        """Sync wrapper for check_limit."""
        if endpoint in EXEMPT_ENDPOINTS:
            return True, 0
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(asyncio.run, self._async_check_limit(user_id, endpoint))
            return future.result()


# Global rate limiter instance (initialized in app.py)
_rate_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    """Get or create the global rate limiter instance."""
    global _rate_limiter
    if _rate_limiter is None:
        _rate_limiter = RateLimiter()
    return _rate_limiter


def init_rate_limiter(db_path: Path | str = DB_PATH) -> RateLimiter:
    """Initialize the global rate limiter (called at app startup)."""
    global _rate_limiter
    _rate_limiter = RateLimiter(db_path)
    return _rate_limiter