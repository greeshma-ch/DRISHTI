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
    assert r.json() == {"status": "ok"}


def test_spend_empty() -> None:
    with patch("server.app.SPEND_LOG", Path(tempfile.mktemp())):
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
        with patch("server.app.SPEND_LOG", Path(f.name)):
            r = client.get("/spend")
            data = r.json()
            assert data["total_usd"] == 70.0
            assert data["level"] == "warn"


def test_spend_throttle_level() -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 100.0}) + "\n")
        f.flush()
        with patch("server.app.SPEND_LOG", Path(f.name)):
            r = client.get("/spend")
            data = r.json()
            assert data["total_usd"] == 100.0
            assert data["level"] == "throttle"


def test_spend_blocked_level() -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write(json.dumps({"est_cost_usd": 130.0}) + "\n")
        f.flush()
        with patch("server.app.SPEND_LOG", Path(f.name)):
            r = client.get("/spend")
            data = r.json()
            assert data["total_usd"] == 130.0
            assert data["level"] == "blocked"
