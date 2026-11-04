"""Fault injection tests for P4 - Critical requirement.

Each test mocks a Meta API failure and verifies the expected spoken message exactly once.
Test cases:
1. Meta 500 -> "Vision limited, moving-object alerts only" (after 3 consecutive -> circuit opens)
2. Meta timeout (8s) -> "Vision limited..." (after 3 consecutive)
3. Meta 429 -> "Vision limited..." (client handles Retry-After, speaks once)
4. Malformed JSON -> "Vision limited..." (after 3 parse failures)
5. Server unreachable (connection error) -> "Vision limited..." (after 3 consecutive)
6. Circuit breaker open -> "Vision limited..." immediately (degraded result)
7. Our own 429 (rate limiter) -> "Vision limited..." (client handles Retry-After)
8. Spend > $120 (not FINAL_RUN) -> blocked, "Vision limited..." (degraded result)
9. Valid response with no hazards -> NOTHING spoken (Hard Rule 1, silence)
10. Valid response with hazard -> phrase spoken (confidence >= 0.6: normal; < 0.6: "possible ...")
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient, Response

from server.app import app
from server.circuit_breaker import get_circuit_state, reset_circuit_breaker
from server.meta_client import (
    analyze_frame,
    reset_parse_failures,
    reset_perception_stats,
)
from server.rate_limiter import init_rate_limiter


@pytest.fixture(autouse=True)
def reset_all():
    """Reset all global state before each test."""
    reset_parse_failures()
    reset_perception_stats()
    reset_circuit_breaker()
    # Reset spend tracking
    import server.meta_client as mc
    mc._total_spend_usd = 0.0
    mc._spend_loaded = False
    # Clear spend log
    spend_log = Path("eval/spend.jsonl")
    if spend_log.exists():
        spend_log.unlink()
    # Clear rate limiter database
    rl_db = Path("eval/rate_limits.sqlite")
    if rl_db.exists():
        try:
            rl_db.unlink()
        except PermissionError:
            pass  # Windows file locking, ignore
    wal_db = rl_db.with_suffix(".sqlite-wal")
    if wal_db.exists():
        try:
            wal_db.unlink()
        except PermissionError:
            pass
    shm_db = rl_db.with_suffix(".sqlite-shm")
    if shm_db.exists():
        try:
            shm_db.unlink()
        except PermissionError:
            pass
    yield
    reset_parse_failures()
    reset_perception_stats()
    reset_circuit_breaker()
    mc._total_spend_usd = 0.0
    mc._spend_loaded = False


@pytest.fixture(autouse=True)
def init_rate_limiter_for_tests():
    """Ensure rate limiter is initialized for tests."""
    init_rate_limiter()
    yield


# Test 1: Meta 500 -> Circuit breaker opens after 3 failures -> degraded result
@pytest.mark.asyncio
async def test_meta_500_triggers_vision_limited() -> None:
    """Meta 500 error -> circuit breaker opens after 3 failures -> degraded (circuit_open)."""
    error_response = Response(500, json={"error": "Internal Server Error"}, request=httpx.Request("POST", "http://test"))
    mock_http = AsyncMock()
    mock_http.post = AsyncMock(return_value=error_response)

    # First 2 failures - circuit breaker closed, exceptions caught by analyze_frame -> unknown
    for i in range(2):
        result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
        assert result.status == "unknown"

    # 3rd failure -> circuit breaker opens, returns degraded (circuit_open)
    result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
    assert result.status == "degraded"
    assert result.reason == "circuit_open"
    assert result.instruction == "Vision limited, moving-object alerts only"


# Test 2: Meta timeout (8s) -> Circuit breaker opens after 3 timeouts -> degraded result
@pytest.mark.asyncio
async def test_meta_timeout_triggers_vision_limited() -> None:
    """Meta timeout -> circuit breaker opens after 3 failures -> degraded (circuit_open)."""
    async def slow_response(*args, **kwargs):
        import asyncio
        await asyncio.sleep(10)
        return Response(200, json={}, request=httpx.Request("POST", "http://test"))

    mock_http = AsyncMock()
    mock_http.post = AsyncMock(side_effect=slow_response)

    # First 2 timeouts - circuit breaker closed, exceptions caught -> unknown
    for i in range(2):
        result, _, _, _ = await analyze_frame(b"dummy", client=mock_http, timeout=0.01)
        assert result.status == "unknown"

    # 3rd timeout -> circuit breaker opens, returns degraded (circuit_open)
    result, _, _, _ = await analyze_frame(b"dummy", client=mock_http, timeout=0.01)
    assert result.status == "degraded"
    assert result.reason == "circuit_open"
    assert result.instruction == "Vision limited, moving-object alerts only"


# Test 3: Meta 429 -> Circuit breaker opens after 3 failures -> degraded result
@pytest.mark.asyncio
async def test_meta_429_triggers_vision_limited() -> None:
    """Meta 429 -> circuit breaker opens after 3 failures -> degraded (circuit_open)."""
    error_response = Response(429, json={"error": "Rate limited"}, request=httpx.Request("POST", "http://test"))
    mock_http = AsyncMock()
    mock_http.post = AsyncMock(return_value=error_response)

    for i in range(3):
        result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
        if i < 2:
            assert result.status == "unknown"
        else:
            assert result.status == "degraded"
            assert result.reason == "circuit_open"
            assert result.instruction == "Vision limited, moving-object alerts only"


# Test 4: Malformed JSON -> Vision limited after 3 parse failures (parse failure logic, not circuit breaker)
@pytest.mark.asyncio
async def test_malformed_json_triggers_vision_limited() -> None:
    """Malformed JSON from Meta -> Vision limited after 3 parse failures (parse failure logic)."""
    malformed_response = Response(200, text="not valid json {{{", request=httpx.Request("POST", "http://test"))
    mock_http = AsyncMock()
    mock_http.post = AsyncMock(return_value=malformed_response)

    # Parse failures don't go through circuit breaker (successful HTTP response)
    # They trigger the consecutive parse failure logic in analyze_frame
    for i in range(3):
        result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
        if i < 2:
            assert result.status == "unknown"
        else:
            assert result.status == "vision limited"
            assert result.instruction == "Vision limited"


# Test 5: Server unreachable (connection error) -> Circuit breaker opens after 3 failures -> degraded result
@pytest.mark.asyncio
async def test_connection_error_triggers_vision_limited() -> None:
    """Connection error -> circuit breaker opens after 3 failures -> degraded (circuit_open)."""
    mock_http = AsyncMock()
    mock_http.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

    for i in range(3):
        result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
        if i < 2:
            assert result.status == "unknown"
        else:
            assert result.status == "degraded"
            assert result.reason == "circuit_open"
            assert result.instruction == "Vision limited, moving-object alerts only"


# Test 6: Circuit breaker open -> Vision limited immediately (degraded result)
@pytest.mark.asyncio
async def test_circuit_breaker_open_returns_degraded() -> None:
    """Circuit breaker open -> degraded result immediately."""
    # First, open the circuit breaker with 3 failures
    mock_http = AsyncMock()
    mock_http.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

    for _ in range(3):
        await analyze_frame(b"dummy", client=mock_http)

    # Verify circuit is open
    state = get_circuit_state()
    assert state["state"] == "open"

    # Next call should return degraded immediately (without calling Meta)
    call_count = 0
    async def counting_fail(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        raise httpx.ConnectError("Connection refused")

    mock_http2 = AsyncMock()
    mock_http2.post = AsyncMock(side_effect=counting_fail)

    result, usage, _, _ = await analyze_frame(b"dummy", client=mock_http2)
    assert result.status == "degraded"
    assert result.reason == "circuit_open"
    assert result.instruction == "Vision limited, moving-object alerts only"
    assert call_count == 0  # Meta API not called


# Test 7: Our own 429 (rate limiter) -> Vision limited (client handles Retry-After)
@pytest.mark.asyncio
async def test_rate_limiter_429_returns_degraded() -> None:
    """Rate limiter 429 -> degraded result with retry_after."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Make 4 concurrent requests to exceed burst of 3 before refill
        async def make_request(i: int):
            files = {"file": ("test.jpg", b"dummy", "image/jpeg")}
            data = {"timestamp": str(time.time()), "lang": "en"}
            print(f"TEST: Making request {i+1}", flush=True)
            resp = await client.post("/frame", files=files, data=data)
            print(f"TEST: Request {i+1} status={resp.status_code}", flush=True)
            return resp

        responses = await asyncio.gather(*[make_request(i) for i in range(4)])

        # Exactly 3 should succeed (burst limit = 3), 1 should be rate limited
        status_codes = [resp.status_code for resp in responses]
        assert status_codes.count(200) == 3, f"Expected 3 200s, got {status_codes}"
        assert status_codes.count(429) == 1, f"Expected 1 429, got {status_codes}"
        rate_limited_resp = next(resp for resp in responses if resp.status_code == 429)
        body = rate_limited_resp.json()
        assert body["status"] == "degraded"
        assert body["reason"] == "rate_limited"
        assert "retry_after" in body
        assert "Retry-After" in rate_limited_resp.headers


# Test 8: Spend > $120 (not FINAL_RUN) -> blocked, degraded result
@pytest.mark.asyncio
async def test_spend_over_120_blocks_calls() -> None:
    """Spend > $120 blocks calls (non-FINAL_RUN)."""
    # Manually set spend over $120
    import server.meta_client as mc
    mc._total_spend_usd = 125.0
    mc._spend_loaded = True

    result, usage, _, _ = await analyze_frame(b"dummy")
    assert result.status == "degraded"
    assert result.reason == "spend_blocked"
    assert result.instruction == "Vision limited, moving-object alerts only"
    assert usage.get("error") == "spend_limit_exceeded"
    assert usage.get("finish_reason") == "blocked"


# Test 9: Valid response with no hazards -> NOTHING spoken (Hard Rule 1)
@pytest.mark.asyncio
async def test_valid_empty_hazard_silent() -> None:
    """Valid response with no hazards -> silence (Hard Rule 1)."""
    valid_empty_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({"hazard": None, "hazards": []})},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=valid_empty_response, request=req))

    result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
    assert result.status == "clear"
    assert result.instruction == ""
    assert result.path_clear is True
    assert result.hazard is None
    assert result.hazards == []


# Test 10: Valid response with hazard -> phrase spoken (hedged wording for low confidence)
@pytest.mark.asyncio
async def test_valid_hazard_spoken_normal_confidence() -> None:
    """Valid response with hazard (confidence >= 0.6) -> normal phrase."""
    valid_hazard_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({
                "hazard": {
                    "type": "pole",
                    "direction": "left",
                    "distance": "near",
                    "clear_side": "right",
                    "urgency": 2,
                    "confidence": 0.95,
                }
            })},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=valid_hazard_response, request=req))

    result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
    assert result.status == "hazard"
    assert result.instruction == "Pole left, step right"  # Normal phrase, no "possible"
    assert result.hazard is not None
    assert result.hazard.confidence == 0.95


@pytest.mark.asyncio
async def test_valid_hazard_spoken_low_confidence_hedged() -> None:
    """Valid response with hazard (confidence < 0.6) -> hedged phrase with 'possible' (truncated to 4 words)."""
    valid_hazard_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({
                "hazard": {
                    "type": "pole",
                    "direction": "left",
                    "distance": "near",
                    "clear_side": "right",
                    "urgency": 2,
                    "confidence": 0.4,  # Low confidence
                }
            })},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=valid_hazard_response, request=req))

    result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
    assert result.status == "hazard"
    assert result.instruction == "possible Pole left, step"  # Truncated to 4 words
    assert result.hazard is not None
    assert result.hazard.confidence == 0.4


@pytest.mark.asyncio
async def test_valid_hazard_stop_phrase_no_possible() -> None:
    """Stop phrase (vehicle center) never gets 'possible' prefix even with low confidence."""
    valid_hazard_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({
                "hazard": {
                    "type": "vehicle",
                    "direction": "center",
                    "distance": "near",
                    "clear_side": "none",
                    "urgency": 3,
                    "confidence": 0.4,  # Low confidence
                }
            })},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=valid_hazard_response, request=req))

    result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
    assert result.status == "hazard"
    # Stop phrase should NOT have "possible" prefix
    assert result.instruction == "Vehicle ahead, stop"
    assert not result.instruction.startswith("possible")
    assert not result.instruction.startswith("संभावित")


# Additional test: Verify circuit breaker state transitions are logged
@pytest.mark.asyncio
async def test_circuit_breaker_state_transitions_logged() -> None:
    """Verify circuit breaker state transitions."""
    state = get_circuit_state()
    assert state["state"] == "closed"
    assert state["failure_count"] == 0

    mock_http = AsyncMock()
    mock_http.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

    # 1 failure
    await analyze_frame(b"dummy", client=mock_http)
    state = get_circuit_state()
    assert state["state"] == "closed"
    assert state["failure_count"] == 1

    # 2 failures
    await analyze_frame(b"dummy", client=mock_http)
    state = get_circuit_state()
    assert state["state"] == "closed"
    assert state["failure_count"] == 2

    # 3 failures -> open
    await analyze_frame(b"dummy", client=mock_http)
    state = get_circuit_state()
    assert state["state"] == "open"
    assert state["failure_count"] == 3


# Test: FINAL_RUN bypasses spend block
@pytest.mark.asyncio
async def test_final_run_bypasses_spend_block() -> None:
    """FINAL_RUN=True bypasses spend block."""
    import server.meta_client as mc
    mc._total_spend_usd = 125.0
    mc._spend_loaded = True

    with patch("server.meta_client.settings.FINAL_RUN", True):
        valid_hazard_response = {
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": json.dumps({"hazard": None})},
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10},
        }
        mock_http = AsyncMock()
        req = httpx.Request("POST", "http://test")
        mock_http.post = AsyncMock(return_value=Response(200, json=valid_hazard_response, request=req))

        result, _, _, _ = await analyze_frame(b"dummy", client=mock_http)
        # Should not be degraded despite spend > $120
        assert result.status != "degraded"
