"""Circuit Breaker for Meta API calls (P4).

Single-worker assumption: this module uses module-level state protected by asyncio.Lock.
In a multi-worker deployment (e.g., gunicorn with multiple workers), each worker would have
its own circuit breaker state. For the current single-worker FastAPI deployment, this is safe.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger(__name__)

# Module-level state (single-worker assumption documented above)
_circuit_state: str = "closed"  # "closed" | "open" | "half-open"
_failure_count: int = 0
_last_failure_time: float = 0.0
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


# Config from settings
_OPEN_THRESHOLD = settings.CIRCUIT_BREAKER_THRESHOLD  # 3
_OPEN_DURATION = settings.CIRCUIT_BREAKER_OPEN_DURATION  # 30s
_TIMEOUT = settings.CIRCUIT_BREAKER_TIMEOUT  # 8s

# Degraded result returned when circuit is open or half-open fails
DEGRADED_RESULT = {
    "status": "degraded",
    "reason": "circuit_open",
    "hazard": None,
    "hazards": [],
    "path_clear": False,
    "instruction": "Vision limited",
    "signage_text": [],
}


def _is_retryable_error(exc: Exception) -> bool:
    """Check if an exception should count as a circuit breaker failure.

    Failures counted: timeouts, connection errors, Meta 5xx, Meta 429
    NOT counted: JSONDecodeError (parse errors), other exceptions
    """
    if isinstance(exc, asyncio.TimeoutError):
        return True
    if isinstance(exc, (httpx.ConnectError, ConnectionError, OSError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status >= 500 or status == 429
    return False


async def _check_and_update_state() -> str:
    """Check circuit state and transition if needed. Returns current state."""
    global _circuit_state, _failure_count, _last_failure_time
    async with _get_lock():
        now = time.time()
        if _circuit_state == "open":
            if now - _last_failure_time >= _OPEN_DURATION:
                _circuit_state = "half-open"
                logger.info("Circuit breaker: transitioning to half-open")
            return _circuit_state
        return _circuit_state


async def call_with_circuit_breaker(coro, timeout: float | None = None) -> Any:
    """Execute a coroutine with circuit breaker protection.

    Args:
        coro: Awaitable to execute
        timeout: Per-attempt timeout in seconds (default from settings)

    Returns:
        Result from coro, or DEGRADED_RESULT dict if circuit is open/half-open fails

    Failures counted: timeouts, connection errors, Meta 5xx, Meta 429
    Valid response with no hazards = success (resets failure count)

    Circuit breaker behavior:
    - Closed: execute coroutine, on success return result, on failure increment count and re-raise
    - Half-open: execute coroutine, on success close circuit, on failure open circuit and return degraded
    - Open: return degraded immediately
    """
    global _circuit_state, _failure_count, _last_failure_time

    if timeout is None:
        timeout = _TIMEOUT

    # Check state first
    state = await _check_and_update_state()
    if state == "open":
        if hasattr(coro, "close"):
            coro.close()
        logger.warning("Circuit breaker: open, returning degraded result immediately")
        return DEGRADED_RESULT

    try:
        # Run with timeout
        result = await asyncio.wait_for(coro, timeout=timeout)
        # Success - reset failure count and close circuit if half-open
        async with _get_lock():
            if _circuit_state == "half-open":
                _circuit_state = "closed"
                _failure_count = 0
                logger.info("Circuit breaker: closed after successful half-open call")
            elif _circuit_state == "closed":
                _failure_count = 0
        return result
    except TimeoutError:
        logger.warning("Circuit breaker: call timed out after %.1fs", timeout)
        async with _get_lock():
            _failure_count += 1
            _last_failure_time = time.time()
            logger.warning("Circuit breaker: failure %d/%d", _failure_count, _OPEN_THRESHOLD)
            if _failure_count >= _OPEN_THRESHOLD:
                _circuit_state = "open"
                logger.error("Circuit breaker: OPEN after %d failures, will retry after %.1fs", _failure_count, _OPEN_DURATION)
                return DEGRADED_RESULT
        # Re-raise when circuit is still closed
        raise
    except Exception as exc:
        # Only count retryable errors as failures
        if _is_retryable_error(exc):
            logger.warning("Circuit breaker: call failed (%s): %s", type(exc).__name__, exc)
            async with _get_lock():
                _failure_count += 1
                _last_failure_time = time.time()
                logger.warning("Circuit breaker: failure %d/%d", _failure_count, _OPEN_THRESHOLD)
                if _failure_count >= _OPEN_THRESHOLD:
                    _circuit_state = "open"
                    logger.error("Circuit breaker: OPEN after %d failures, will retry after %.1fs", _failure_count, _OPEN_DURATION)
                    return DEGRADED_RESULT
        # Re-raise for non-retryable errors (like JSONDecodeError) or when circuit still closed
        raise


def get_circuit_state() -> dict[str, Any]:
    """Get current circuit breaker state for debugging/status."""
    return {
        "state": _circuit_state,
        "failure_count": _failure_count,
        "threshold": _OPEN_THRESHOLD,
        "open_duration_sec": _OPEN_DURATION,
        "timeout_sec": _TIMEOUT,
    }


def reset_circuit_breaker() -> None:
    """Reset circuit breaker to closed state (for testing)."""
    global _circuit_state, _failure_count, _last_failure_time, _lock
    _circuit_state = "closed"
    _failure_count = 0
    _last_failure_time = 0.0
    _lock = None
