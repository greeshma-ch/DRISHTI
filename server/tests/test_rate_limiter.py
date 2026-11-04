"""Tests for rate limiter (P4)."""

from __future__ import annotations

import sqlite3
import tempfile
import time
from pathlib import Path

import pytest

from server.rate_limiter import RateLimiter


@pytest.fixture
def temp_db():
    """Create a temporary database for testing."""
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as f:
        db_path = Path(f.name)
    yield db_path
    # Cleanup - handle Windows file locking
    for path in [db_path, db_path.with_suffix(".sqlite-wal"), db_path.with_suffix(".sqlite-shm")]:
        if path.exists():
            try:
                path.unlink()
            except PermissionError:
                pass  # Windows file locking, ignore


def test_frame_endpoint_burst_and_sustained(temp_db: Path) -> None:
    """Frame endpoint: allows burst 3, then 1.2/s sustained."""
    limiter = RateLimiter(temp_db)
    user_id = "test_user"

    # Burst of 3 should be allowed
    for i in range(3):
        allowed, retry_after = limiter.consume(user_id, "frame")
        assert allowed is True, f"Burst request {i+1} should be allowed"
        assert retry_after == 0

    # 4th request should be rate limited
    allowed, retry_after = limiter.consume(user_id, "frame")
    assert allowed is False
    assert retry_after >= 1  # At least 1 second

    # Wait for token refill (1/1.2 ≈ 0.83s per token)
    time.sleep(1.0)
    allowed, retry_after = limiter.consume(user_id, "frame")
    assert allowed is True
    assert retry_after == 0

    limiter.close()


def test_chat_endpoint_10_per_minute(temp_db: Path) -> None:
    """Chat endpoint: 10/min (10/60 per second)."""
    limiter = RateLimiter(temp_db)
    user_id = "test_user"

    # 10 requests should be allowed (burst)
    for i in range(10):
        allowed, retry_after = limiter.consume(user_id, "chat")
        assert allowed is True, f"Chat request {i+1} should be allowed"

    # 11th should be limited
    allowed, retry_after = limiter.consume(user_id, "chat")
    assert allowed is False
    assert retry_after >= 1

    limiter.close()


def test_geocode_endpoint_global_1_per_second(temp_db: Path) -> None:
    """Geocode endpoint: 1/s global (not per-user)."""
    limiter = RateLimiter(temp_db)

    # First request allowed
    allowed, retry_after = limiter.consume("user1", "geocode")
    assert allowed is True

    # Second request (even from different user) should be limited
    allowed, retry_after = limiter.consume("user2", "geocode")
    assert allowed is False
    assert retry_after >= 1

    # Wait and try again
    time.sleep(1.1)
    allowed, retry_after = limiter.consume("user1", "geocode")
    assert allowed is True

    limiter.close()


def test_429_with_retry_after_header(temp_db: Path) -> None:
    """Returns 429 with Retry-After header (seconds)."""
    limiter = RateLimiter(temp_db)
    user_id = "test_user"

    # Exhaust burst
    for _ in range(3):
        limiter.consume(user_id, "frame")

    allowed, retry_after = limiter.consume(user_id, "frame")
    assert allowed is False
    assert isinstance(retry_after, int)
    assert retry_after >= 1

    limiter.close()


def test_sqlite_persistence_across_restarts(temp_db: Path) -> None:
    """SQLite persistence across restarts (WAL mode)."""
    user_id = "test_user"

    # First limiter instance - consume some tokens
    limiter1 = RateLimiter(temp_db)
    for _ in range(2):
        limiter1.consume(user_id, "frame")
    limiter1.close()

    # Second limiter instance - should see remaining tokens
    limiter2 = RateLimiter(temp_db)
    # Should have 1 token left (burst 3 - 2 consumed)
    allowed, retry_after = limiter2.consume(user_id, "frame")
    assert allowed is True
    # Next should be limited
    allowed, retry_after = limiter2.consume(user_id, "frame")
    assert allowed is False
    limiter2.close()


def test_prune_at_startup_older_than_24h(temp_db: Path) -> None:
    """Prune at startup: rows older than 24h deleted."""
    # Manually insert old data
    with sqlite3.connect(temp_db, check_same_thread=False) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rate_limits (
                user_id TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                tokens REAL NOT NULL,
                last_refill REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (user_id, endpoint)
            )
        """)
        old_time = time.time() - 90000  # 25 hours ago
        conn.execute(
            "INSERT INTO rate_limits (user_id, endpoint, tokens, last_refill, updated_at) VALUES (?, ?, ?, ?, ?)",
            ("old_user", "frame", 1.0, old_time, old_time),
        )
        recent_time = time.time() - 100  # 100 seconds ago
        conn.execute(
            "INSERT INTO rate_limits (user_id, endpoint, tokens, last_refill, updated_at) VALUES (?, ?, ?, ?, ?)",
            ("recent_user", "frame", 1.0, recent_time, recent_time),
        )
        conn.commit()

    # Create limiter - should prune old entries
    limiter = RateLimiter(temp_db)

    # Check old entry was pruned
    with sqlite3.connect(temp_db, check_same_thread=False) as conn:
        cursor = conn.execute("SELECT COUNT(*) FROM rate_limits WHERE user_id = 'old_user'")
        count = cursor.fetchone()[0]
        assert count == 0, "Old entry should be pruned"

        cursor = conn.execute("SELECT COUNT(*) FROM rate_limits WHERE user_id = 'recent_user'")
        count = cursor.fetchone()[0]
        assert count == 1, "Recent entry should remain"

    limiter.close()


def test_exempt_endpoints(temp_db: Path) -> None:
    """Exempt endpoints: /health, /status, /spend, /emergency/*"""
    limiter = RateLimiter(temp_db)
    user_id = "test_user"

    exempt = ["health", "status", "spend", "emergency"]
    for endpoint in exempt:
        allowed, retry_after = limiter.consume(user_id, endpoint)
        assert allowed is True, f"Endpoint {endpoint} should be exempt"
        assert retry_after == 0

    limiter.close()


def test_keyed_by_x_user_id_fallback_to_ip(temp_db: Path) -> None:
    """Keyed by X-User-Id header, fallback to client IP."""
    # This is tested at the app.py level where the header is extracted
    # Here we just verify the limiter works with arbitrary user_id strings
    limiter = RateLimiter(temp_db)

    # Test with user_id
    allowed, _ = limiter.consume("user_123", "frame")
    assert allowed is True

    # Test with IP-like string
    allowed, _ = limiter.consume("192.168.1.1", "frame")
    assert allowed is True

    limiter.close()


def test_wal_mode_enabled(temp_db: Path) -> None:
    """Verify WAL mode is enabled."""
    limiter = RateLimiter(temp_db)
    # Do a consume to trigger WAL file creation
    limiter.consume("test_user", "frame")
    # Check WAL file exists BEFORE closing (WAL file may be deleted on close)
    wal_path = temp_db.with_suffix(".sqlite-wal")
    assert wal_path.exists(), "WAL file should exist"
    limiter.close()
