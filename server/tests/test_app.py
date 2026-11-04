"""Tests for health and spend endpoints."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.app import app

client = TestClient(app)


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    expected = {
        "status": "ok",
        "dry_run": data["dry_run"],
        "telegram_configured": data["telegram_configured"],
    }
    assert data == expected
    assert set(data.keys()) == {"status", "dry_run", "telegram_configured"}
    assert isinstance(data["dry_run"], bool)
    assert isinstance(data["telegram_configured"], bool)
    # No secrets or tokens in response
    for v in data.values():
        assert v not in ("changeme", ""), "secret value leaked"


def test_spend_empty() -> None:
    with patch("server.app.SPEND_LOG", Path(tempfile.mktemp())):
        with patch("server.meta_client.SPEND_LOG", Path(tempfile.mktemp())):
            import server.meta_client as mc
            mc._spend_loaded = False
            mc._total_spend_usd = 0.0
            r = client.get("/spend")
            assert r.status_code == 200
            data = r.json()
            assert data["total_usd"] == 0.0
            assert data["records"] == 0
            assert data["level"] == "normal"


def test_spend_warn_level() -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        for _ in range(10):
            f.write(json.dumps({"est_cost_usd": 7.0}) + "\n")
        f.flush()
        with patch("server.meta_client.SPEND_LOG", Path(f.name)):
            # Reset the in-memory spend total
            import server.meta_client as mc
            mc._spend_loaded = False
            mc._total_spend_usd = 0.0
            r = client.get("/spend")
            data = r.json()
            assert data["total_usd"] == 70.0
            assert data["level"] == "warn"


def test_spend_throttle_level() -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 100.0}) + "\n")
        f.flush()
        with patch("server.meta_client.SPEND_LOG", Path(f.name)):
            import server.meta_client as mc
            mc._spend_loaded = False
            mc._total_spend_usd = 0.0
            r = client.get("/spend")
            data = r.json()
            assert data["total_usd"] == 100.0
            assert data["level"] == "throttle"


def test_spend_blocked_level() -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 130.0}) + "\n")
        f.flush()
        with patch("server.meta_client.SPEND_LOG", Path(f.name)):
            import server.meta_client as mc
            mc._spend_loaded = False
            mc._total_spend_usd = 0.0
            r = client.get("/spend")
            data = r.json()
            assert data["total_usd"] == 130.0
            assert data["level"] == "blocked"
