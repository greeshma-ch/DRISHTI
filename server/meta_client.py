"""Meta API client — all Meta API calls go through here (AGENTS.md rule 6)."""

from __future__ import annotations

import base64
import json
import logging
import statistics
import time
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, Field, field_validator

from .config import settings
from .phrases import build_phrase
from .circuit_breaker import call_with_circuit_breaker, DEGRADED_RESULT as CB_DEGRADED_RESULT

logger = logging.getLogger(__name__)

SPEND_LOG = Path("eval/spend.jsonl")
PRICES_FILE = Path("server/prices.json")

# In-memory running spend total (loaded from file at startup, updated on each call)
_total_spend_usd: float = 0.0
_spend_loaded: bool = False


def _load_spend_total() -> float:
    """Load total spend from eval/spend.jsonl into memory. Called once at startup."""
    global _total_spend_usd, _spend_loaded
    if not SPEND_LOG.exists():
        _total_spend_usd = 0.0
        _spend_loaded = True
        return 0.0
    total = 0.0
    try:
        for line in SPEND_LOG.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                total += float(row.get("est_cost_usd", 0.0))
    except Exception:
        pass
    _total_spend_usd = round(total, 6)
    _spend_loaded = True
    logger.info("Spend guard: loaded total $%.4f from %s", _total_spend_usd, SPEND_LOG)
    return _total_spend_usd


def get_total_spend(log_path: Path | None = None) -> float:
    """Get current total spend (from in-memory running total)."""
    if not _spend_loaded:
        _load_spend_total()
    return _total_spend_usd


VALID_HAZARD_TYPES = {
    "chair",
    "table",
    "bench",
    "door",
    "wall",
    "pole",
    "tree_branch",
    "vehicle",
    "rickshaw",
    "bicycle",
    "person",
    "animal",
    "stairs",
    "step_down",
    "pothole",
    "open_drain",
    "construction",
    "plant",
    "bag",
    "other",
}
VALID_DIRECTIONS = {"left", "center", "right"}
VALID_DISTANCES = {"near", "mid", "far"}
VALID_CLEAR_SIDES = {"left", "right", "none"}

URGENCY_WORD_MAP = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 3,
}

CONFIDENCE_WORD_MAP = {
    "low": 0.3,
    "medium": 0.6,
    "high": 0.9,
}


class Hazard(BaseModel):
    type: str = "other"
    direction: str = "center"
    distance: str = "mid"
    clear_side: str = "none"
    label: str | None = None
    urgency: int = Field(default=0, ge=0, le=3)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)

    @field_validator("type", mode="before")
    @classmethod
    def normalize_type(cls, v: Any) -> str:
        s = str(v).lower().strip().replace(" ", "_")
        return s if s in VALID_HAZARD_TYPES else "other"

    @field_validator("direction", mode="before")
    @classmethod
    def normalize_direction(cls, v: Any) -> str:
        s = str(v).lower().strip()
        return s if s in VALID_DIRECTIONS else "center"

    @field_validator("distance", mode="before")
    @classmethod
    def normalize_distance(cls, v: Any) -> str:
        s = str(v).lower().strip()
        return s if s in VALID_DISTANCES else "mid"

    @field_validator("clear_side", mode="before")
    @classmethod
    def normalize_clear_side(cls, v: Any) -> str:
        s = str(v).lower().strip()
        return s if s in VALID_CLEAR_SIDES else "none"

    @field_validator("label", mode="before")
    @classmethod
    def normalize_label(cls, v: Any) -> str | None:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        words = s.split()
        return " ".join(words[:2])

    @field_validator("urgency", mode="before")
    @classmethod
    def normalize_urgency(cls, v: Any) -> int:
        if isinstance(v, str):
            s = v.lower().strip()
            if s in URGENCY_WORD_MAP:
                return URGENCY_WORD_MAP[s]
            try:
                return max(0, min(3, int(round(float(s)))))
            except ValueError:
                return 0
        if isinstance(v, (int, float)):
            return max(0, min(3, int(round(v))))
        return 0

    @field_validator("confidence", mode="before")
    @classmethod
    def normalize_confidence(cls, v: Any) -> float:
        if isinstance(v, str):
            s = v.lower().strip()
            if s in CONFIDENCE_WORD_MAP:
                return CONFIDENCE_WORD_MAP[s]
            try:
                return round(max(0.0, min(1.0, float(s))), 3)
            except ValueError:
                return 0.0
        if isinstance(v, (int, float)):
            return round(max(0.0, min(1.0, float(v))), 3)
        return 0.0


class PerceptionResult(BaseModel):
    status: str = "unknown"
    hazard: Hazard | None = None
    hazards: list[Hazard] = []
    path_clear: bool = False
    instruction: str = "unknown"
    signage_text: list[str] = []
    suggested_interval_ms: int | None = None
    reason: str | None = None


UNKNOWN_RESULT = PerceptionResult(
    status="unknown",
    hazard=None,
    hazards=[],
    path_clear=False,
    instruction="unknown",
    signage_text=[],
)

VISION_LIMITED_RESULT = PerceptionResult(
    status="vision limited",
    hazard=None,
    hazards=[],
    path_clear=False,
    instruction="Vision limited",
    signage_text=[],
)

# Degraded results for different reasons
DEGRADED_CIRCUIT_OPEN = PerceptionResult(
    status="degraded",
    hazard=None,
    hazards=[],
    path_clear=False,
    instruction="Vision limited, moving-object alerts only",
    signage_text=[],
    reason="circuit_open",
)

DEGRADED_SPEND_BLOCKED = PerceptionResult(
    status="degraded",
    hazard=None,
    hazards=[],
    path_clear=False,
    instruction="Vision limited, moving-object alerts only",
    signage_text=[],
    reason="spend_blocked",
)

DEGRADED_RATE_LIMITED = PerceptionResult(
    status="degraded",
    hazard=None,
    hazards=[],
    path_clear=False,
    instruction="Vision limited, moving-object alerts only",
    signage_text=[],
    reason="rate_limited",
)

_consecutive_parse_failures: int = 0
_total_frames: int = 0
_retry_frames: int = 0
_reasoning_tokens_history: list[int] = []


def reset_parse_failures() -> None:
    global _consecutive_parse_failures
    _consecutive_parse_failures = 0


def get_perception_stats() -> dict[str, Any]:
    global _total_frames, _retry_frames, _reasoning_tokens_history
    med = (
        float(statistics.median(_reasoning_tokens_history))
        if _reasoning_tokens_history
        else 0.0
    )
    ratio = (_retry_frames / _total_frames) if _total_frames > 0 else 0.0
    return {
        "total_frames": _total_frames,
        "retry_frames": _retry_frames,
        "retries_display": f"{_retry_frames} / {_total_frames}",
        "retry_ratio": round(ratio, 4),
        "retry_percent": round(ratio * 100, 1),
        "median_reasoning_tokens": round(med, 1),
        "consecutive_parse_failures": _consecutive_parse_failures,
    }


def reset_perception_stats() -> None:
    global _total_frames, _retry_frames, _reasoning_tokens_history, _consecutive_parse_failures
    _total_frames = 0
    _retry_frames = 0
    _consecutive_parse_failures = 0
    _reasoning_tokens_history.clear()


SYSTEM_PROMPT = (
    "You are Drishti walking companion. "
    "Identify the single most urgent imminent hazard in path "
    "(stairs up or down, drop-offs, obstacles). "
    "Return ONLY JSON: "
    '{"hazard":{"type":"chair|table|bench|door|wall|pole|tree_branch|vehicle|rickshaw|'
    'bicycle|person|animal|stairs|step_down|pothole|open_drain|construction|plant|bag|other",'
    '"direction":"left|center|right","distance":"near|mid|far",'
    '"clear_side":"left|right|none","label":"max 2 words if other","urgency":0-3}} '
    'or {"hazard":null}'
)


def load_prices() -> dict[str, Any]:
    if PRICES_FILE.exists():
        try:
            return json.loads(PRICES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def calculate_cost(
    model: str, input_tokens: int, output_tokens: int, images: int = 1
) -> float:
    prices = load_prices().get(model, {})
    in_rate = prices.get("input_per_1k_tokens", 0.0018) / 1000.0
    out_rate = prices.get("output_per_1k_tokens", 0.0072) / 1000.0
    img_rate = prices.get("per_image", 0.0015)
    return round((input_tokens * in_rate) + (output_tokens * out_rate) + (images * img_rate), 6)


def record_spend(
    model: str, input_tokens: int, output_tokens: int, images: int, est_cost_usd: float
) -> None:
    global _total_spend_usd
    record = {
        "ts": time.time(),
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "images": images,
        "audio_seconds": 0.0,
        "est_cost_usd": est_cost_usd,
    }
    SPEND_LOG.parent.mkdir(parents=True, exist_ok=True)
    with SPEND_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    _total_spend_usd = round(_total_spend_usd + est_cost_usd, 6)


def parse_perception_response(
    content: str, count_failure: bool = True, lang: str = "en"
) -> PerceptionResult:
    """Parse JSON defensively. Returns PerceptionResult with status."""
    global _consecutive_parse_failures
    if not content or not content.strip():
        if count_failure:
            _consecutive_parse_failures += 1
            if _consecutive_parse_failures >= 3:
                return VISION_LIMITED_RESULT
        return UNKNOWN_RESULT
    try:
        data = json.loads(content)
        if not isinstance(data, dict):
            raise ValueError("Expected JSON object")

        if "hazard" not in data and "hazards" not in data and "result" in data:
            if isinstance(data["result"], dict):
                data = data["result"]

        hazard: Hazard | None = None
        valid_hazards: list[Hazard] = []

        if "hazard" in data and isinstance(data["hazard"], dict):
            try:
                h = Hazard(**data["hazard"])
                valid_hazards.append(h)
                hazard = h
            except Exception as h_err:
                logger.debug("Dropped invalid hazard: %s", h_err)
        elif "hazards" in data and isinstance(data["hazards"], list):
            for item in data["hazards"]:
                if isinstance(item, dict):
                    try:
                        valid_hazards.append(Hazard(**item))
                    except Exception as h_err:
                        logger.debug("Dropped invalid hazard %s: %s", item, h_err)
            if valid_hazards:
                hazard = max(valid_hazards, key=lambda x: x.urgency)

        if hazard is not None:
            # Apply hedged wording based on confidence
            confidence = hazard.confidence
            instruction = build_phrase(
                hazard_type=hazard.type,
                direction=hazard.direction,
                clear_side=hazard.clear_side,
                label=hazard.label,
                lang=lang,
                confidence=confidence,
            )
            status = "hazard"
            path_clear = False
        else:
            # Valid parse with no hazards: status "clear", never speak anything (Hard Rule 1)
            status = "clear"
            instruction = ""
            path_clear = True

        raw_signage = data.get("signage_text", [])
        signage = [str(s) for s in raw_signage] if isinstance(raw_signage, list) else []

        if count_failure:
            _consecutive_parse_failures = 0

        return PerceptionResult(
            status=status,
            hazard=hazard,
            hazards=valid_hazards,
            path_clear=path_clear,
            instruction=instruction,
            signage_text=signage,
        )
    except Exception as exc:
        logger.warning("Failed to parse perception response: %s", exc)
        if count_failure:
            _consecutive_parse_failures += 1
            if _consecutive_parse_failures >= 3:
                return VISION_LIMITED_RESULT
        return UNKNOWN_RESULT


async def analyze_frame(
    image_bytes: bytes,
    lang: str = "en",
    client: httpx.AsyncClient | None = None,
    timeout: float | None = None,
) -> tuple[PerceptionResult, dict[str, Any], float, dict[str, float]]:
    """Call Meta Model API with image and return (result, usage_dict, latency_ms, timings).

    Args:
        image_bytes: JPEG image data
        lang: Language code ("en" or "hi")
        client: Optional httpx.AsyncClient to use
        timeout: Per-attempt timeout in seconds for circuit breaker (default from settings)
    """
    global _consecutive_parse_failures, _total_frames, _retry_frames, _reasoning_tokens_history

    # Ensure spend total is loaded
    if not _spend_loaded:
        _load_spend_total()

    current_spend = _total_spend_usd
    now_ts = time.time()

    # Spend guard: block at $120 (unless FINAL_RUN)
    if current_spend >= 120.0 and not settings.FINAL_RUN:
        logger.error("Spend guard blocked call: current spend $%.2f exceeds limit", current_spend)
        return (
            DEGRADED_SPEND_BLOCKED,
            {"error": "spend_limit_exceeded", "finish_reason": "blocked"},
            0.0,
            {"meta_call_start": now_ts, "meta_call_end": now_ts},
        )

    # Spend guard: throttle at $90 (suggest longer interval)
    suggested_interval_ms = None
    if current_spend >= 90.0:
        suggested_interval_ms = 4000  # 4 seconds

    _total_frames += 1
    did_retry = False
    b64_image = base64.b64encode(image_bytes).decode("utf-8")
    user_prompt = "Return single most urgent hazard only: {\"hazard\":{...}} or {\"hazard\":null}."

    def make_payload(max_tokens: int) -> dict[str, Any]:
        return {
            "model": settings.SPARK_MODEL,
            "reasoning_effort": "minimal",
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                        },
                    ],
                },
            ],
        }

    headers = {
        "Authorization": f"Bearer {settings.MODEL_API_KEY}",
        "Content-Type": "application/json",
    }
    url = f"{settings.META_BASE_URL.rstrip('/')}/chat/completions"

    owned_client = client is None
    http = client or httpx.AsyncClient(timeout=15.0)

    start_time = time.perf_counter()
    meta_call_start = time.time()
    meta_call_end = time.time()

    async def call_api(max_tokens: int) -> tuple[dict[str, Any], float, float]:
        t0 = time.time()
        resp = await http.post(url, json=make_payload(max_tokens), headers=headers)
        t1 = time.time()
        resp.raise_for_status()
        return resp.json(), t0, t1

    async def call_api_with_circuit_breaker(max_tokens: int):
        """Wrap the API call with circuit breaker."""
        return await call_with_circuit_breaker(call_api(max_tokens), timeout=timeout or settings.CIRCUIT_BREAKER_TIMEOUT)

    try:
        # First attempt: max_tokens = 800
        cb_result = await call_api_with_circuit_breaker(max_tokens=800)

        # Check if circuit breaker returned degraded result
        if isinstance(cb_result, dict) and cb_result.get("status") == "degraded":
            meta_call_end = time.time()
            latency_ms = round((time.perf_counter() - start_time) * 1000, 1)
            degraded = DEGRADED_CIRCUIT_OPEN
            if suggested_interval_ms:
                degraded = degraded.model_copy(update={"suggested_interval_ms": suggested_interval_ms})
            return (
                degraded,
                {"error": "circuit_open", "finish_reason": "circuit_open"},
                latency_ms,
                {"meta_call_start": meta_call_start, "meta_call_end": meta_call_end},
            )

        raw_json, m_start, m_end = cb_result
        meta_call_start, meta_call_end = m_start, m_end
        latency_ms = round((time.perf_counter() - start_time) * 1000, 1)

        choices = raw_json.get("choices", [])
        choice = choices[0] if choices else {}
        finish_reason = str(choice.get("finish_reason") or "unknown")
        content = choice.get("message", {}).get("content", "") or ""

        parsed: PerceptionResult | None = None
        if finish_reason != "length" and content.strip():
            candidate = parse_perception_response(content, count_failure=False, lang=lang)
            if candidate.status != "unknown":
                parsed = candidate

        # Retry once with max_tokens 1200 if length cutoff, empty content, or parse failure
        if parsed is None:
            did_retry = True
            _retry_frames += 1
            logger.warning(
                "First attempt failed (finish_reason=%s, empty=%s); retry max_tokens=1200",
                finish_reason,
                not bool(content.strip()),
            )
            cb_result = await call_api_with_circuit_breaker(max_tokens=1200)

            # Check circuit breaker again
            if isinstance(cb_result, dict) and cb_result.get("status") == "degraded":
                meta_call_end = time.time()
                latency_ms = round((time.perf_counter() - start_time) * 1000, 1)
                degraded = DEGRADED_CIRCUIT_OPEN
                if suggested_interval_ms:
                    degraded = degraded.model_copy(update={"suggested_interval_ms": suggested_interval_ms})
                return (
                    degraded,
                    {"error": "circuit_open", "finish_reason": "circuit_open"},
                    latency_ms,
                    {"meta_call_start": meta_call_start, "meta_call_end": meta_call_end},
                )

            raw_json, m_start, m_end = cb_result
            meta_call_end = m_end
            latency_ms = round((time.perf_counter() - start_time) * 1000, 1)

            choices = raw_json.get("choices", [])
            choice = choices[0] if choices else {}
            finish_reason = str(choice.get("finish_reason") or "unknown")
            content = choice.get("message", {}).get("content", "") or ""
            if finish_reason != "length" and content.strip():
                candidate = parse_perception_response(content, count_failure=False, lang=lang)
                if candidate.status != "unknown":
                    parsed = candidate

        # Requirement B4: If more than 10 percent of frames need a retry, log a warning
        if _total_frames > 0 and (_retry_frames / _total_frames) > 0.10:
            logger.warning(
                "High Tier 2 retry rate: %.1f%% (%d/%d frames required a retry)",
                (_retry_frames / _total_frames) * 100,
                _retry_frames,
                _total_frames,
            )

        usage = raw_json.get("usage", {})
        input_tokens = int(usage.get("prompt_tokens", 0))
        output_tokens = int(usage.get("completion_tokens", 0))
        details = usage.get("completion_tokens_details") or {}
        reasoning_tokens = int(
            details.get("reasoning_tokens") or usage.get("reasoning_tokens") or 0
        )
        _reasoning_tokens_history.append(reasoning_tokens)
        med_reasoning = (
            float(statistics.median(_reasoning_tokens_history))
            if _reasoning_tokens_history
            else 0.0
        )
        est_cost = calculate_cost(settings.SPARK_MODEL, input_tokens, output_tokens, images=1)
        record_spend(settings.SPARK_MODEL, input_tokens, output_tokens, 1, est_cost)

        usage_info = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "median_reasoning_tokens": round(med_reasoning, 1),
            "est_cost_usd": est_cost,
            "finish_reason": finish_reason,
            "retries_count": _retry_frames,
            "total_frames": _total_frames,
            "retries_display": f"{_retry_frames} / {_total_frames}",
            "did_retry": did_retry,
        }
        if suggested_interval_ms:
            usage_info["suggested_interval_ms"] = suggested_interval_ms

        if parsed is not None:
            _consecutive_parse_failures = 0
            if suggested_interval_ms:
                parsed = parsed.model_copy(update={"suggested_interval_ms": suggested_interval_ms})
            return (
                parsed,
                usage_info,
                latency_ms,
                {"meta_call_start": meta_call_start, "meta_call_end": meta_call_end},
            )

        _consecutive_parse_failures += 1
        res = VISION_LIMITED_RESULT if _consecutive_parse_failures >= 3 else UNKNOWN_RESULT
        if suggested_interval_ms and res != VISION_LIMITED_RESULT:
            res = res.model_copy(update={"suggested_interval_ms": suggested_interval_ms})
        return (
            res,
            usage_info,
            latency_ms,
            {"meta_call_start": meta_call_start, "meta_call_end": meta_call_end},
        )

    except Exception as exc:
        meta_call_end = time.time()
        latency_ms = round((time.perf_counter() - start_time) * 1000, 1)
        logger.warning("Meta API call failed (%s): %s", type(exc).__name__, exc)
        _consecutive_parse_failures += 1
        res = VISION_LIMITED_RESULT if _consecutive_parse_failures >= 3 else UNKNOWN_RESULT
        if suggested_interval_ms and res != VISION_LIMITED_RESULT:
            res = res.model_copy(update={"suggested_interval_ms": suggested_interval_ms})
        return (
            res,
            {"error": str(exc), "finish_reason": "error"},
            latency_ms,
            {"meta_call_start": meta_call_start, "meta_call_end": meta_call_end},
        )
    finally:
        if owned_client:
            await http.aclose()