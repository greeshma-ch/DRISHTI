"""Emergency endpoint (P6) — relays to Telegram, logs one line."""

from __future__ import annotations

import hashlib
import logging
import time
from collections import defaultdict
from typing import Final

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from .auth import verify_emergency_token
from .config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/emergency", tags=["emergency"])

# In-memory abuse cap: 10 requests/hour per user_id (independent of P4 limiter)
_emergency_rate_limit: dict[str, list[float]] = defaultdict(list)
_EMERGENCY_RATE_LIMIT: Final = 10
_EMERGENCY_WINDOW_SEC: Final = 3600

TELEGRAM_API_BASE: Final = "https://api.telegram.org/bot"


class EmergencyRequest(BaseModel):
    user_id: str
    token: str
    contacts: list[int] = Field(..., min_length=1, max_length=10)
    location: dict[str, float] | None = None  # {lat, lon}
    recent_alerts: list[str] = Field(default=[])
    lang: str = "en"
    test: bool = False

    @field_validator("location")
    @classmethod
    def validate_location(cls, v: dict[str, float] | None) -> dict[str, float] | None:
        if v is None:
            return None
        if "lat" not in v or "lon" not in v:
            raise ValueError("Location must have lat and lon")
        lat, lon = v["lat"], v["lon"]
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            raise ValueError("Invalid lat/lon")
        return v

    @field_validator("recent_alerts")
    @classmethod
    def validate_alerts(cls, v: list[str]) -> list[str]:
        # Truncate to 3 alerts, each max 200 chars
        return [a[:200] for a in v[:3]]


class EmergencyResponse(BaseModel):
    ok: bool
    message: str
    sent_count: int
    dry_run: bool


def check_emergency_rate_limit(user_id: str) -> bool:
    """Check if user_id is within 10/hour emergency limit."""
    now = time.time()
    window_start = now - _EMERGENCY_WINDOW_SEC
    requests = _emergency_rate_limit[user_id]
    while requests and requests[0] < window_start:
        requests.pop(0)
    if len(requests) >= _EMERGENCY_RATE_LIMIT:
        return False
    requests.append(now)
    return True


def format_ist_time(ts: float) -> str:
    """Format timestamp as IST (UTC+5:30)."""
    import datetime

    dt = datetime.datetime.fromtimestamp(ts, tz=datetime.UTC)
    ist = dt + datetime.timedelta(hours=5, minutes=30)
    return ist.strftime("%Y-%m-%d %H:%M:%S IST")


def build_telegram_message(
    name: str,
    location: dict[str, float] | None,
    recent_alerts: list[str],
    timestamp: float,
    test: bool,
) -> str:
    """
    Build Telegram message with ONLY:
    - name
    - map link (if location)
    - time (IST)
    - last 3 alert phrases
    - "Sent by Drishti"
    - TEST prefix if test=true
    """
    lines = []

    prefix = "[TEST] " if test else ""
    lines.append(f"{prefix}{name} may need help")

    if location:
        lat, lon = location["lat"], location["lon"]
        map_link = f"https://maps.google.com/?q={lat},{lon}"
        lines.append(f"Location: {map_link}")
    else:
        lines.append("Location: unavailable")

    lines.append(f"Time: {format_ist_time(timestamp)}")

    if recent_alerts:
        lines.append("Recent alerts:")
        for alert in recent_alerts:
            lines.append(f"  - {alert}")

    lines.append("Sent by Drishti")

    return "\n".join(lines)


async def send_telegram_message(chat_id: int, text: str) -> bool:
    """Send message via Telegram Bot API. Returns True on success."""
    if not settings.TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not configured")
        return False

    url = f"{TELEGRAM_API_BASE}{settings.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                logger.warning(
                    "Telegram send failed for chat_id %s: %s %s",
                    chat_id,
                    resp.status_code,
                    resp.text[:200],
                )
                return False
            return True
    except Exception as exc:
        logger.warning("Telegram send error for chat_id %s: %s", chat_id, exc)
        return False


def _log_emergency_request(user_id: str, contacts_count: int, dry_run: bool, outcome: str) -> None:
    """Log one sanitized line per emergency request."""
    user_hash = hashlib.sha256(user_id.encode()).hexdigest()[:8]
    logger.info(
        "emergency user_hash=%s contacts=%d dry_run=%s outcome=%s",
        user_hash,
        contacts_count,
        dry_run,
        outcome,
    )


@router.post("", response_model=EmergencyResponse)
async def emergency(
    body: EmergencyRequest,
) -> EmergencyResponse:
    """
    Emergency endpoint — validates HMAC, checks 10/hr cap, sends Telegram, logs one line.
    Exempt from P4 general rate limiter; has independent 10/hr per user_id cap.
    """
    # Verify token
    verify_emergency_token(body.user_id, body.token)

    # Check emergency-specific rate limit
    if not check_emergency_rate_limit(body.user_id):
        _log_emergency_request(
            body.user_id, len(body.contacts), settings.EMERGENCY_DRY_RUN, "rate_limited"
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Emergency rate limit exceeded (10/hour)",
        )

    # Build message
    timestamp = time.time()
    message = build_telegram_message(
        name=body.user_id,  # Using user_id as name per spec (local profile name passed in real use)
        location=body.location,
        recent_alerts=body.recent_alerts,
        timestamp=timestamp,
        test=body.test,
    )

    # Dry-run: log only, don't send
    if settings.EMERGENCY_DRY_RUN:
        _log_emergency_request(body.user_id, len(body.contacts), True, "dry_run")
        return EmergencyResponse(
            ok=True,
            message="Dry run: message logged",
            sent_count=len(body.contacts),
            dry_run=True,
        )

    # Send to each contact
    sent = 0
    for chat_id in body.contacts:
        if await send_telegram_message(chat_id, message):
            sent += 1

    # Log ONE line with minimal info (no token, no chat ids, no coordinates)
    outcome = "sent" if sent > 0 else "failed"
    _log_emergency_request(body.user_id, len(body.contacts), False, outcome)

    if sent == 0:
        return EmergencyResponse(
            ok=False,
            message="Failed to send to any contact",
            sent_count=0,
            dry_run=False,
        )

    return EmergencyResponse(
        ok=True,
        message=f"Sent to {sent} contact(s)",
        sent_count=sent,
        dry_run=False,
    )
