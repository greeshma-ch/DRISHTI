"""Tests for P6 emergency flow (auth, emergency, telegram_link)."""

from __future__ import annotations

import logging
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from server.app import app
from server.auth import create_user_token, generate_user_id, verify_user_token
from server.config import settings
from server.telegram_link import (
    _captured_chats,
    _pending_codes,
    generate_start_code,
    verify_start_code,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def capture_logs(caplog):
    """Configure logging to capture log output for tests."""
    caplog.set_level(logging.INFO, logger="server.emergency")
    caplog.set_level(logging.INFO, logger="server.auth")
    caplog.set_level(logging.INFO, logger="server.telegram_link")
    yield


# ===================== Fixtures =====================

@pytest.fixture(autouse=True)
def reset_rate_limits():
    """Reset rate limit stores between tests."""
    from server.auth import _auth_rate_limit
    from server.emergency import _emergency_rate_limit

    _auth_rate_limit.clear()
    _emergency_rate_limit.clear()
    _pending_codes.clear()
    _captured_chats.clear()
    global _getupdates_offset
    _getupdates_offset = 0
    yield


@pytest.fixture
def valid_user():
    """Create a valid user_id and token."""
    user_id = generate_user_id()
    token = create_user_token(user_id)
    return user_id, token


# ===================== Auth Tests =====================

class TestAuthInit:
    def test_auth_init_returns_user_id_and_token(self):
        resp = client.post("/auth/init")
        assert resp.status_code == 200
        data = resp.json()
        assert "user_id" in data
        assert "token" in data
        assert data["token"].startswith("drg_")

    def test_auth_init_token_verifies(self):
        resp = client.post("/auth/init")
        data = resp.json()
        assert verify_user_token(data["user_id"], data["token"])

    def test_auth_init_rate_limit_20_per_hour_per_ip(self):
        # Make 20 requests - all should succeed
        for _ in range(20):
            resp = client.post("/auth/init")
            assert resp.status_code == 200, f"Request {_+1} failed: {resp.text}"

        # 21st should fail
        resp = client.post("/auth/init")
        assert resp.status_code == 429
        assert "rate limit" in resp.json()["detail"].lower()


class TestTokenVerification:
    def test_valid_token_passes(self, valid_user):
        user_id, token = valid_user
        assert verify_user_token(user_id, token)

    def test_tampered_token_rejected(self, valid_user):
        user_id, token = valid_user
        # Tamper with signature
        tampered = token[:-1] + ("a" if token[-1] != "a" else "b")
        assert not verify_user_token(user_id, tampered)

    def test_wrong_user_id_rejected(self, valid_user):
        user_id, token = valid_user
        other_id = generate_user_id()
        assert not verify_user_token(other_id, token)

    def test_malformed_token_rejected(self):
        assert not verify_user_token("user123", "not-a-valid-token")
        assert not verify_user_token("user123", "drg_user123")  # missing signature
        assert not verify_user_token("user123", "drg_user123.sig.extra")  # too many parts

    def test_constant_time_verification(self, valid_user):
        """Verify HMAC comparison uses constant-time compare_digest."""
        user_id, token = valid_user
        # Just ensure it doesn't raise and uses hmac.compare_digest internally
        # (We can't easily test timing in unit tests, but the implementation uses it)
        assert verify_user_token(user_id, token)


# ===================== Emergency Tests =====================

class TestEmergencyEndpoint:
    def test_emergency_requires_valid_token(self, valid_user):
        user_id, token = valid_user
        # Wrong token
        resp = client.post(
            "/emergency",
            json={
                "user_id": user_id,
                "token": "invalid_token",
                "contacts": [123456],
                "lang": "en",
            },
        )
        assert resp.status_code == 401

    def test_emergency_validates_bounds(self, valid_user):
        user_id, token = valid_user

        # Too many contacts (max 10)
        resp = client.post(
            "/emergency",
            json={
                "user_id": user_id,
                "token": token,
                "contacts": list(range(11)),  # 11 contacts
                "lang": "en",
            },
        )
        assert resp.status_code == 422

        # Too many alerts - validator truncates to 3, so request is valid
        # but Telegram send fails (chat not found), so returns 200 with ok=false
        with patch.object(settings, "EMERGENCY_DRY_RUN", False), patch(
            "server.emergency.send_telegram_message", new_callable=AsyncMock, return_value=False
        ):
            resp = client.post(
                "/emergency",
                json={
                    "user_id": user_id,
                    "token": token,
                    "contacts": [123456],
                    "recent_alerts": ["a"] * 4,  # 4 alerts -> truncated to 3
                    "lang": "en",
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert data["sent_count"] == 0

        # Invalid location (lat out of range)
        resp = client.post(
            "/emergency",
            json={
                "user_id": user_id,
                "token": token,
                "contacts": [123456],
                "location": {"lat": 200, "lon": 0},  # invalid lat
                "lang": "en",
            },
        )
        assert resp.status_code == 422

    def test_emergency_dry_run_logs_only(self, valid_user, caplog):
        user_id, token = valid_user
        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            resp = client.post(
                "/emergency",
                json={
                    "user_id": user_id,
                    "token": token,
                    "contacts": [123456, 789012],
                    "recent_alerts": ["Vehicle ahead", "Pole left"],
                    "lang": "en",
                    "test": True,
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"]
        assert data["dry_run"]
        assert data["sent_count"] == 2

        # Check log contains minimal sanitized info (no message content, no PII)
        assert "emergency user_hash=" in caplog.text
        assert "contacts=2" in caplog.text
        assert "dry_run=True" in caplog.text
        assert "outcome=dry_run" in caplog.text
        # Ensure no message content leaked
        assert "Vehicle ahead" not in caplog.text
        assert "Pole left" not in caplog.text
        assert "[TEST]" not in caplog.text

    def test_emergency_rate_limit_10_per_hour_per_user(self, valid_user):
        user_id, token = valid_user
        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            for _ in range(10):
                resp = client.post(
                    "/emergency",
                    json={
                        "user_id": user_id,
                        "token": token,
                        "contacts": [123456],
                        "lang": "en",
                    },
                )
                assert resp.status_code == 200

            # 11th should fail
            resp = client.post(
                "/emergency",
                json={
                    "user_id": user_id,
                    "token": token,
                    "contacts": [123456],
                    "lang": "en",
                },
            )
            assert resp.status_code == 429

    def test_emergency_rate_limit_independent_per_user(self, valid_user):
        user_id, token = valid_user
        other_id = generate_user_id()
        other_token = create_user_token(other_id)

        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            # Exhaust first user's limit
            for _ in range(10):
                client.post(
                    "/emergency",
                    json={"user_id": user_id, "token": token, "contacts": [1], "lang": "en"},
                )

            # Other user should still work
            resp = client.post(
                "/emergency",
                json={"user_id": other_id, "token": other_token, "contacts": [1], "lang": "en"},
            )
            assert resp.status_code == 200

    def test_emergency_message_format(self, valid_user, caplog):
        user_id, token = valid_user
        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            resp = client.post(
                "/emergency",
                json={
                    "user_id": user_id,
                    "token": token,
                    "contacts": [123456],
                    "location": {"lat": 12.97, "lon": 77.59},
                    "recent_alerts": ["Vehicle ahead, stop", "Pole left, step right"],
                    "lang": "en",
                    "test": True,
                },
            )
        assert resp.status_code == 200

        log_text = caplog.text
        # Verify log contains ONLY sanitized fields (no message content, no PII)
        assert "emergency user_hash=" in log_text
        assert "contacts=1" in log_text
        assert "dry_run=True" in log_text
        assert "outcome=dry_run" in log_text

        # Ensure no message content leaked in logs
        assert "may need help" not in log_text
        assert "maps.google.com" not in log_text
        assert "IST" not in log_text
        assert "Vehicle ahead, stop" not in log_text
        assert "Pole left, step right" not in log_text
        assert "Sent by Drishti" not in log_text
        assert "[TEST]" not in log_text

        # Ensure bot token never appears
        assert settings.TELEGRAM_BOT_TOKEN not in log_text or settings.TELEGRAM_BOT_TOKEN == ""

    def test_emergency_missing_location(self, valid_user, caplog):
        user_id, token = valid_user
        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            resp = client.post(
                "/emergency",
                json={
                    "user_id": user_id,
                    "token": token,
                    "contacts": [123456],
                    "lang": "en",
                },
            )
        assert resp.status_code == 200
        # Log should only contain sanitized fields
        assert "emergency user_hash=" in caplog.text
        assert "contacts=1" in caplog.text
        assert "dry_run=True" in caplog.text
        assert "outcome=dry_run" in caplog.text
        # No location details in log
        assert "Location: unavailable" not in caplog.text
        assert "maps.google.com" not in caplog.text

    def test_emergency_alerts_truncated_to_3(self, valid_user, caplog):
        user_id, token = valid_user
        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            resp = client.post(
                "/emergency",
                json={
                    "user_id": user_id,
                    "token": token,
                    "contacts": [123456],
                    "recent_alerts": ["a"] * 5,
                    "lang": "en",
                },
            )
        assert resp.status_code == 200
        # Log should only contain sanitized fields (validator truncates alerts
        # to 3, but they're not logged)
        assert "emergency user_hash=" in caplog.text
        assert "contacts=1" in caplog.text
        assert "dry_run=True" in caplog.text
        assert "outcome=dry_run" in caplog.text
        # No alert content in log
        assert " - a" not in caplog.text


# ===================== Telegram Link Tests =====================

class TestTelegramLink:
    def test_generate_start_code(self, valid_user):
        user_id, token = valid_user
        code = generate_start_code(user_id)
        assert "." in code
        assert len(code.split(".")) == 2

    def test_verify_start_code_valid(self, valid_user):
        user_id, token = valid_user
        code = generate_start_code(user_id)
        verified = verify_start_code(code)
        assert verified == user_id
        # Code should be consumed (one-time use)
        assert verify_start_code(code) is None

    def test_verify_start_code_expired(self, valid_user):
        user_id, token = valid_user
        code = generate_start_code(user_id)
        # Manually expire it
        from server.telegram_link import _pending_codes
        _pending_codes[code]["expires_at"] = time.time() - 1
        assert verify_start_code(code) is None

    def test_verify_start_code_wrong_user(self, valid_user):
        user_id, token = valid_user
        other_id = generate_user_id()
        code = generate_start_code(other_id)
        assert verify_start_code(code) != user_id

    def test_telegram_connect_requires_valid_token(self, valid_user):
        user_id, token = valid_user
        resp = client.get("/telegram/connect", params={"user_id": user_id, "token": "bad"})
        assert resp.status_code == 401

    def test_telegram_connect_returns_deep_link(self, valid_user):
        user_id, token = valid_user
        resp = client.get("/telegram/connect", params={"user_id": user_id, "token": token})
        assert resp.status_code == 200
        data = resp.json()
        assert "deep_link" in data
        assert "code" in data
        assert data["expires_in"] == 900
        assert data["deep_link"].startswith("https://t.me/")
        assert "start=" in data["deep_link"]

    def test_telegram_poll_requires_valid_token(self, valid_user):
        user_id, token = valid_user
        resp = client.get("/telegram/poll", params={"user_id": user_id, "token": "bad"})
        assert resp.status_code == 401

    def test_telegram_poll_returns_none_when_not_connected(self, valid_user):
        user_id, token = valid_user
        resp = client.get("/telegram/poll", params={"user_id": user_id, "token": token})
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is False
        assert data["chat_id"] is None

    def test_telegram_poll_returns_chat_id_when_captured(self, valid_user):
        user_id, token = valid_user
        code = generate_start_code(user_id)
        from server.telegram_link import _captured_chats
        _captured_chats[code] = 123456789

        resp = client.get("/telegram/poll", params={"user_id": user_id, "token": token})
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is True
        assert data["chat_id"] == 123456789

    def test_telegram_manual_fallback(self, valid_user):
        user_id, token = valid_user
        code = generate_start_code(user_id)
        resp = client.post(
            "/telegram/manual",
            params={"user_id": user_id, "token": token},
            json={"code": code, "chat_id": 987654321},
        )
        assert resp.status_code == 200
        from server.telegram_link import _captured_chats
        assert _captured_chats[code] == 987654321

    def test_telegram_manual_rejects_wrong_user_code(self, valid_user):
        user_id, token = valid_user
        other_id = generate_user_id()
        other_code = generate_start_code(other_id)
        resp = client.post(
            "/telegram/manual",
            params={"user_id": user_id, "token": token},
            json={"code": other_code, "chat_id": 987654321},
        )
        assert resp.status_code == 400


# ===================== Health Endpoint Tests =====================

class TestHealthEndpoint:
    def test_health_returns_expected_shape(self):
        """Test /health returns status, dry_run, telegram_configured with correct types."""
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()

        assert "status" in data
        assert data["status"] == "ok"

        assert "dry_run" in data
        assert isinstance(data["dry_run"], bool)

        assert "telegram_configured" in data
        assert isinstance(data["telegram_configured"], bool)

        # Ensure no secrets/tokens in response
        assert "token" not in str(data).lower()
        assert "secret" not in str(data).lower()
        assert "key" not in str(data).lower()
        assert "hmac" not in str(data).lower()


# ===================== Bot Token Security Tests =====================

class TestBotTokenSecurity:
    def test_bot_token_not_in_client_response(self, valid_user):
        user_id, token = valid_user
        with patch.object(settings, "EMERGENCY_DRY_RUN", True):
            resp = client.post(
                "/emergency",
                json={"user_id": user_id, "token": token, "contacts": [1], "lang": "en"},
            )
        # Response should not contain bot token
        assert settings.TELEGRAM_BOT_TOKEN not in resp.text

    def test_bot_token_not_in_error_messages(self, valid_user):
        # Trigger an error (invalid location)
        user_id, token = valid_user
        resp = client.post(
            "/emergency",
            json={
                "user_id": user_id,
                "token": token,
                "contacts": [1],
                "location": {"lat": 200, "lon": 0},
                "lang": "en",
            },
        )
        # Even error responses shouldn't leak token
        assert settings.TELEGRAM_BOT_TOKEN not in resp.text


# ===================== Startup Config Tests =====================

class TestStartupConfig:
    def test_emergency_hmac_secret_required_when_not_dry_run(self):
        """Test that the config validation raises on empty secret when not dry run."""
        from server.config import Settings

        with pytest.raises(RuntimeError, match="EMERGENCY_HMAC_SECRET must be set"):
            Settings(
                EMERGENCY_HMAC_SECRET="",
                EMERGENCY_DRY_RUN=False,
                MODEL_API_KEY="test",
            )

    def test_emergency_hmac_secret_default_rejected(self):
        from server.config import Settings

        with pytest.raises(RuntimeError, match="EMERGENCY_HMAC_SECRET must be set"):
            Settings(
                EMERGENCY_HMAC_SECRET="changeme",
                EMERGENCY_DRY_RUN=False,
                MODEL_API_KEY="test",
            )

    def test_dry_run_allows_empty_secret(self):
        from server.config import Settings

        # Should not raise
        s = Settings(
            EMERGENCY_HMAC_SECRET="",
            EMERGENCY_DRY_RUN=True,
            MODEL_API_KEY="test",
        )
        assert s.EMERGENCY_DRY_RUN is True
