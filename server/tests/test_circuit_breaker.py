"""Tests for circuit breaker (P4)."""

from __future__ import annotations

import asyncio
import pytest
from unittest.mock import patch
import time

from server.circuit_breaker import (
    call_with_circuit_breaker,
    get_circuit_state,
    reset_circuit_breaker,
    DEGRADED_RESULT,
)


@pytest.fixture(autouse=True)
def reset_cb():
    """Reset circuit breaker before each test."""
    reset_circuit_breaker()
    yield
    reset_circuit_breaker()


@pytest.mark.asyncio
async def test_circuit_closed_on_success() -> None:
    """Successful calls keep circuit closed."""
    async def success_coro():
        return "ok"

    result = await call_with_circuit_breaker(success_coro())
    assert result == "ok"
    state = get_circuit_state()
    assert state["state"] == "closed"
    assert state["failure_count"] == 0


@pytest.mark.asyncio
async def test_circuit_opens_after_3_failures() -> None:
    """Circuit opens after 3 consecutive failures."""
    async def fail_coro():
        raise ConnectionError("connection failed")

    # 1st failure - exception re-raised
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    state = get_circuit_state()
    assert state["state"] == "closed"
    assert state["failure_count"] == 1

    # 2nd failure - exception re-raised
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    state = get_circuit_state()
    assert state["state"] == "closed"
    assert state["failure_count"] == 2

    # 3rd failure -> circuit opens, returns degraded
    result3 = await call_with_circuit_breaker(fail_coro())
    assert result3 == DEGRADED_RESULT
    state = get_circuit_state()
    assert state["state"] == "open"
    assert state["failure_count"] == 3


@pytest.mark.asyncio
async def test_circuit_stays_open_returns_degraded() -> None:
    """Once open, circuit returns degraded immediately without calling coro."""
    async def fail_coro():
        raise ConnectionError("connection failed")

    # Open the circuit - first 2 raise, 3rd returns degraded
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    result = await call_with_circuit_breaker(fail_coro())
    assert result == DEGRADED_RESULT

    call_count = 0
    async def counting_fail_coro():
        nonlocal call_count
        call_count += 1
        raise ConnectionError("connection failed")

    # Should return degraded without calling the coroutine
    result = await call_with_circuit_breaker(counting_fail_coro())
    assert result == DEGRADED_RESULT
    assert call_count == 0  # Coroutine not called


@pytest.mark.asyncio
async def test_circuit_half_open_after_30s() -> None:
    """Circuit transitions to half-open after 30 seconds."""
    async def fail_coro():
        raise ConnectionError("connection failed")

    # Open the circuit - first 2 raise, 3rd returns degraded
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    await call_with_circuit_breaker(fail_coro())  # 3rd opens circuit, returns degraded

    state = get_circuit_state()
    assert state["state"] == "open"

    # Mock time to simulate 30 seconds passing
    with patch("server.circuit_breaker.time.time", return_value=time.time() + 31):
        async def success_coro():
            return "ok"
        result = await call_with_circuit_breaker(success_coro())
        assert result == "ok"
        state = get_circuit_state()
        assert state["state"] == "closed"  # Successful half-open call closes circuit


@pytest.mark.asyncio
async def test_circuit_half_open_failure_reopens() -> None:
    """If half-open call fails, circuit reopens."""
    async def fail_coro():
        raise ConnectionError("connection failed")

    # Open the circuit - first 2 raise, 3rd returns degraded
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    await call_with_circuit_breaker(fail_coro())  # 3rd opens circuit, returns degraded

    # Mock time to simulate 30 seconds passing
    with patch("server.circuit_breaker.time.time", return_value=time.time() + 31):
        result = await call_with_circuit_breaker(fail_coro())
        assert result == DEGRADED_RESULT
        state = get_circuit_state()
        assert state["state"] == "open"  # Failed half-open reopens circuit


@pytest.mark.asyncio
async def test_timeout_counts_as_failure() -> None:
    """Timeout counts as a failure."""
    async def slow_coro():
        await asyncio.sleep(10)
        return "ok"

    # First timeout - exception re-raised
    with pytest.raises(asyncio.TimeoutError):
        await call_with_circuit_breaker(slow_coro(), timeout=0.01)
    state = get_circuit_state()
    assert state["failure_count"] == 1
    assert state["state"] == "closed"

    # Second timeout
    with pytest.raises(asyncio.TimeoutError):
        await call_with_circuit_breaker(slow_coro(), timeout=0.01)
    state = get_circuit_state()
    assert state["failure_count"] == 2

    # Third timeout -> circuit opens, returns degraded
    result = await call_with_circuit_breaker(slow_coro(), timeout=0.01)
    assert result == DEGRADED_RESULT
    state = get_circuit_state()
    assert state["failure_count"] == 3
    assert state["state"] == "open"


@pytest.mark.asyncio
async def test_valid_empty_hazard_resets_failure_count() -> None:
    """Valid response with no hazards = success (resets failure count)."""
    async def fail_coro():
        raise ConnectionError("connection failed")

    async def success_coro():
        return {"hazard": None, "hazards": []}  # Valid empty response

    # Two failures
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    with pytest.raises(ConnectionError):
        await call_with_circuit_breaker(fail_coro())
    state = get_circuit_state()
    assert state["failure_count"] == 2

    # Valid empty response resets failure count
    result = await call_with_circuit_breaker(success_coro())
    assert result == {"hazard": None, "hazards": []}
    state = get_circuit_state()
    assert state["failure_count"] == 0
    assert state["state"] == "closed"


@pytest.mark.asyncio
async def test_concurrent_access_safety() -> None:
    """Circuit breaker is safe under concurrent access."""
    async def fail_coro():
        await asyncio.sleep(0.01)
        raise ConnectionError("connection failed")

    # Run multiple concurrent calls - first 2 should raise, 3rd+ should return degraded
    tasks = [call_with_circuit_breaker(fail_coro()) for _ in range(10)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Check that we got a mix of exceptions and degraded results
    degraded_count = sum(1 for r in results if r == DEGRADED_RESULT)
    exception_count = sum(1 for r in results if isinstance(r, Exception))
    assert degraded_count > 0
    assert exception_count > 0
    state = get_circuit_state()
    assert state["failure_count"] >= 3
    assert state["state"] == "open"