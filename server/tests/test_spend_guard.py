"""Tests for spend guard (P4)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from server.app import app
from server.meta_client import (
    _load_spend_total,
    record_spend,
)


@pytest.fixture(autouse=True)
def reset_spend():
    """Reset spend tracking before each test."""
    import server.meta_client as mc
    mc._total_spend_usd = 0.0
    mc._spend_loaded = False
    spend_log = Path("eval/spend.jsonl")
    if spend_log.exists():
        spend_log.unlink()
    yield
    mc._total_spend_usd = 0.0
    mc._spend_loaded = False
    if spend_log.exists():
        spend_log.unlink()


def test_spend_endpoint_returns_level_total_prices() -> None:
    """/spend returns level, total_usd, prices_used dict."""
    transport = ASGITransport(app=app)
    # Use a temp spend log
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 10.0}) + "\n")
        f.write(json.dumps({"est_cost_usd": 20.0}) + "\n")
        temp_path = Path(f.name)

    with patch("server.app.SPEND_LOG", temp_path):
        import server.meta_client as mc
        mc.SPEND_LOG = temp_path
        import server.app as app_module
        app_module.SPEND_LOG = temp_path

        import asyncio
        async def test():
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.get("/spend")
                assert resp.status_code == 200
                data = resp.json()
                assert "level" in data
                assert "total_usd" in data
                assert "prices_used" in data
                assert data["total_usd"] == 30.0
                assert data["level"] == "normal"
                assert isinstance(data["prices_used"], dict)

        asyncio.run(test())

    temp_path.unlink()


def test_spend_total_loaded_from_file_at_startup() -> None:
    """Spend total loaded from eval/spend.jsonl at startup into in-memory running total."""
    # Create spend log with some entries
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 15.0}) + "\n")
        f.write(json.dumps({"est_cost_usd": 25.0}) + "\n")
        temp_path = Path(f.name)

    with patch("server.meta_client.SPEND_LOG", temp_path):
        import server.meta_client as mc
        mc.SPEND_LOG = temp_path
        mc._spend_loaded = False
        mc._total_spend_usd = 0.0

        # Load spend total (simulates startup)
        total = _load_spend_total()
        assert total == 40.0
        assert mc._total_spend_usd == 40.0
        assert mc._spend_loaded is True

    temp_path.unlink()


def test_spend_total_survives_restart() -> None:
    """Restart test: new process loads previous spend total from file."""
    # First "process" - record some spend
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 50.0}) + "\n")
        temp_path = Path(f.name)

    with patch("server.meta_client.SPEND_LOG", temp_path):
        import server.meta_client as mc
        mc.SPEND_LOG = temp_path
        mc._spend_loaded = False
        mc._total_spend_usd = 0.0

        # Simulate first process startup
        total1 = _load_spend_total()
        assert total1 == 50.0

        # Record more spend in first process
        record_spend("muse-spark-1.3", 100, 50, 1, 0.001)
        assert mc._total_spend_usd == 50.001  # 50 + 0.001

        # Simulate second process (restart) - new instance loads from file
        mc._spend_loaded = False
        mc._total_spend_usd = 0.0
        total2 = _load_spend_total()
        # Should load the original 50 + the recorded 0.001 = 50.001
        assert total2 == 50.001

    temp_path.unlink()


def test_spend_levels() -> None:
    """Test spend level thresholds."""
    transport = ASGITransport(app=app)

    test_cases = [
        (30.0, "normal"),
        (70.0, "warn"),
        (100.0, "throttle"),
        (130.0, "blocked"),
    ]

    for total_usd, expected_level in test_cases:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            f.write(json.dumps({"est_cost_usd": total_usd}) + "\n")
            temp_path = Path(f.name)

        with patch("server.app.SPEND_LOG", temp_path):
            import server.meta_client as mc
            mc.SPEND_LOG = temp_path
            mc._total_spend_usd = 0.0
            mc._spend_loaded = False
            import server.app as app_module
            app_module.SPEND_LOG = temp_path

            import asyncio
            async def test():
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    resp = await client.get("/spend")
                    data = resp.json()
                    assert data["level"] == expected_level, f"Expected {expected_level} for ${total_usd}, got {data['level']}"

            asyncio.run(test())

        temp_path.unlink()


def test_frame_includes_suggested_interval_at_90() -> None:
    """At $90: /frame includes suggested_interval_ms=4000."""
    # Set spend to $90
    import server.meta_client as mc
    mc._total_spend_usd = 90.0
    mc._spend_loaded = True

    valid_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({"hazard": None})},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }

    import asyncio
    from unittest.mock import AsyncMock

    from httpx import Request, Response

    mock_http = AsyncMock()
    req = Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=valid_response, request=req))

    async def test():
        result, usage, _, _ = await mc.analyze_frame(b"dummy", client=mock_http)
        assert usage.get("suggested_interval_ms") == 4000

    asyncio.run(test())


def test_frame_blocked_at_120_non_final_run() -> None:
    """At $120: /frame returns degraded (reason=spend_blocked) for non-FINAL_RUN."""
    import server.meta_client as mc
    mc._total_spend_usd = 120.0
    mc._spend_loaded = True

    import asyncio

    async def test():
        r, u, _, _ = await mc.analyze_frame(b"dummy")
        return r, u

    result, usage = asyncio.run(test())
    assert result.status == "degraded"
    assert result.reason == "spend_blocked"


def test_final_run_bypasses_spend_block() -> None:
    """FINAL_RUN=True bypasses spend block."""
    import server.meta_client as mc
    mc._total_spend_usd = 120.0
    mc._spend_loaded = True

    valid_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({"hazard": None})},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }

    from unittest.mock import AsyncMock, patch

    from httpx import Request, Response

    mock_http = AsyncMock()
    req = Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=valid_response, request=req))

    import asyncio

    async def test():
        with patch("server.meta_client.settings.FINAL_RUN", True):
            r, u, _, _ = await mc.analyze_frame(b"dummy", client=mock_http)
            return r, u

    result, usage = asyncio.run(test())
    assert result.status != "degraded"
