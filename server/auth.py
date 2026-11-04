"""Stateless HMAC authentication for emergency flow (P6)."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from collections import defaultdict
from typing import Final

from fastapi import APIRouter, HTTPException, Request, status

from .config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# In-memory rate limiter for /auth/init: 20 requests/hour per IP
# Using a simple sliding window; resets on server restart (acceptable for hackathon)
_auth_rate_limit: dict[str, list[float]] = defaultdict(list)
_AUTH_RATE_LIMIT: Final = 20  # per hour
_AUTH_WINDOW_SEC: Final = 3600

# Token prefix to identify our tokens
TOKEN_PREFIX: Final = "drg_"


def _hmac_sign(data: str) -> str:
    """Compute HMAC-SHA256 of data using EMERGENCY_HMAC_SECRET."""
    return hmac.new(
        settings.EMERGENCY_HMAC_SECRET.encode("utf-8"),
        data.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _hmac_verify(data: str, signature: str) -> bool:
    """Constant-time HMAC verification."""
    expected = _hmac_sign(data)
    return hmac.compare_digest(expected, signature)


def create_user_token(user_id: str) -> str:
    """Create a token for the given user_id: token = prefix + user_id + '.' + HMAC(user_id)."""
    sig = _hmac_sign(user_id)
    return f"{TOKEN_PREFIX}{user_id}.{sig}"


def verify_user_token(user_id: str, token: str) -> bool:
    """
    Verify that token is valid for user_id.
    Expected format: drg_{user_id}.{hmac}
    """
    if not token.startswith(TOKEN_PREFIX):
        return False
    try:
        payload = token[len(TOKEN_PREFIX) :]
        parts = payload.split(".")
        if len(parts) != 2:
            return False
        token_user_id, sig = parts
        if token_user_id != user_id:
            return False
        return _hmac_verify(user_id, sig)
    except Exception:
        return False


def generate_user_id() -> str:
    """Generate a random user_id (URL-safe, no padding)."""
    return secrets.token_urlsafe(16)


def check_auth_rate_limit(ip: str) -> bool:
    """
    Check if IP is within rate limit (20/hour).
    Returns True if allowed, False if rate limited.
    """
    now = time.time()
    window_start = now - _AUTH_WINDOW_SEC
    # Clean old entries
    requests = _auth_rate_limit[ip]
    while requests and requests[0] < window_start:
        requests.pop(0)
    if len(requests) >= _AUTH_RATE_LIMIT:
        return False
    requests.append(now)
    return True


async def get_client_ip(request: Request) -> str:
    """Extract client IP from request (handles proxies)."""
    # Check X-Forwarded-For header (first IP)
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    # Check X-Real-IP header
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip
    # Fall back to client host
    return request.client.host if request.client else "unknown"


@router.post("/init")
async def auth_init(request: Request) -> dict[str, str]:
    """
    Initialize a new anonymous user.
    Returns: {user_id, token}
    Token = HMAC(SECRET, user_id), verified without database.
    Rate limited: 20 requests/hour per IP.
    """
    ip = await get_client_ip(request)
    if not check_auth_rate_limit(ip):
        logger.warning("auth_init rate_limited ip=%s", ip)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded. Try again later.",
        )

    user_id = generate_user_id()
    token = create_user_token(user_id)
    logger.info("auth_init user_id=%s ip=%s", user_id, ip)
    return {"user_id": user_id, "token": token}


def verify_emergency_token(user_id: str, token: str) -> None:
    """Verify emergency request token. Raises 401 if invalid."""
    if not verify_user_token(user_id, token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
