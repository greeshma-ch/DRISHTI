from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient, Response

from server.app import app
from server.meta_client import (
    SYSTEM_PROMPT,
    UNKNOWN_RESULT,
    Hazard,
    PerceptionResult,
    analyze_frame,
    calculate_cost,
    get_perception_stats,
    get_total_spend,
    parse_perception_response,
    record_spend,
    reset_parse_failures,
    reset_perception_stats,
)
from server.phrases import build_phrase, get_system_message


def test_parse_perception_valid() -> None:
    raw = json.dumps({
        "hazards": [
            {
                "type": "pole",
                "direction": "left",
                "distance": "near",
                "clear_side": "right",
                "urgency": 2,
                "confidence": 0.95,
            }
        ],
        "path_clear": False,
        "signage_text": ["STOP"],
    })
    result = parse_perception_response(raw)
    assert len(result.hazards) == 1
    assert result.hazards[0].type == "pole"
    assert result.hazards[0].direction == "left"
    assert result.hazards[0].distance == "near"
    assert result.hazards[0].clear_side == "right"
    assert result.path_clear is False
    assert result.instruction == "Pole left, step right"
    assert result.signage_text == ["STOP"]
    assert result.status == "hazard"


def test_parse_perception_exact_failing_payload_words_coercion() -> None:
    raw = json.dumps({
        "hazards": [
            {
                "type": "vehicle",
                "direction": "left",
                "distance": "near",
                "urgency": "high",
                "confidence": "high",
            }
        ],
        "path_clear": False,
        "instruction": "Car approaching on left",
        "signage_text": [],
    })
    result = parse_perception_response(raw)
    assert len(result.hazards) == 1
    assert result.hazards[0].urgency == 3
    assert result.hazards[0].confidence == 0.9
    assert result.hazards[0].type == "vehicle"
    assert result.hazards[0].direction == "left"
    assert result.status == "hazard"


def test_parse_perception_mixed_valid_invalid_hazards() -> None:
    raw = json.dumps({
        "hazards": [
            {
                "type": "pole",
                "direction": "right",
                "distance": "far",
                "urgency": "low",
                "confidence": "medium",
            },
            "totally_invalid_non_dict_hazard",
            12345,
            {
                "type": "step_down",
                "direction": "center",
                "distance": "near",
                "urgency": 2,
                "confidence": 0.85,
            },
        ],
        "path_clear": False,
        "instruction": "Step down ahead",
    })
    result = parse_perception_response(raw)
    assert len(result.hazards) == 2
    assert result.hazards[0].type == "pole"
    assert result.hazards[0].urgency == 1
    assert result.hazards[0].confidence == 0.6
    assert result.hazards[1].type == "step_down"
    assert result.instruction == "Step down, stop"
    assert result.status == "hazard"


def test_consecutive_parse_failures_triggers_vision_limited() -> None:
    reset_parse_failures()
    bad_payload = "not json {{"

    # Failure 1
    r1 = parse_perception_response(bad_payload)
    assert r1.status == "unknown"
    assert r1.instruction == "unknown"

    # Failure 2
    r2 = parse_perception_response(bad_payload)
    assert r2.status == "unknown"
    assert r2.instruction == "unknown"

    # Failure 3 -> "Vision limited"
    r3 = parse_perception_response(bad_payload)
    assert r3.status == "vision limited"
    assert r3.instruction == "Vision limited"

    # Recovery with valid JSON resets failures
    valid_payload = json.dumps({
        "hazard": None,
        "hazards": [],
    })
    r4 = parse_perception_response(valid_payload)
    assert r4.status == "clear"
    assert r4.instruction == ""

    # Subsequent single failure starts at 1, so returns "unknown", not "Vision limited"
    r5 = parse_perception_response(bad_payload)
    assert r5.status == "unknown"
    assert r5.instruction == "unknown"


def test_parse_perception_defensive_mapping() -> None:
    raw = json.dumps({
        "hazards": [
            {
                "type": "unregistered_flying_saucer",
                "direction": "diagonal_up",
                "distance": "infinite",
                "urgency": 1,
                "confidence": 0.8,
            }
        ],
        "path_clear": True,
        "instruction": "Walk forward",
    })
    result = parse_perception_response(raw)
    assert len(result.hazards) == 1
    assert result.hazards[0].type == "other"
    assert result.hazards[0].direction == "center"
    assert result.hazards[0].distance == "mid"


def test_parse_perception_malformed_json() -> None:
    reset_parse_failures()
    raw = "Not even a json {{{ ]"
    result = parse_perception_response(raw)
    assert result == UNKNOWN_RESULT
    assert result.status == "unknown"
    assert result.instruction == "unknown"


def test_parse_perception_empty_content() -> None:
    reset_parse_failures()
    result = parse_perception_response("")
    assert result == UNKNOWN_RESULT
    assert result.status == "unknown"
    assert result.instruction == "unknown"


def test_clear_only_possible_from_valid_parse_with_empty_hazards() -> None:
    reset_parse_failures()
    # 1. Valid parse with empty hazards -> status is "clear", instruction is "" (nothing spoken)
    raw = json.dumps({"hazard": None, "hazards": []})
    result = parse_perception_response(raw)
    assert result.status == "clear"
    assert result.path_clear is True
    assert result.hazard is None
    assert result.hazards == []
    assert result.instruction == ""

    # 2. Malformed JSON -> never "clear", must give "unknown"
    r_bad = parse_perception_response("{bad")
    assert r_bad.status != "clear"
    assert r_bad.status == "unknown"

    # 3. Empty content -> never "clear", must give "unknown"
    r_empty = parse_perception_response("   ")
    assert r_empty.status != "clear"
    assert r_empty.status == "unknown"


def test_parse_perception_instruction_shortened_to_4_words() -> None:
    raw = json.dumps({
        "hazards": [{"type": "pole", "direction": "center", "confidence": 0.95}],
    })
    result = parse_perception_response(raw)
    assert len(result.instruction.split()) <= 4
    assert result.instruction == "Pole ahead, stop"


def test_spend_calculation_and_record(tmp_path: Path) -> None:
    test_spend_file = tmp_path / "spend.jsonl"
    with patch("server.meta_client.SPEND_LOG", test_spend_file):
        cost = calculate_cost("muse-spark-1.3", input_tokens=328, output_tokens=50, images=1)
        assert cost > 0.0
        record_spend("muse-spark-1.3", 328, 50, 1, cost)
        assert test_spend_file.exists()
        assert get_total_spend(test_spend_file) == cost


@pytest.mark.asyncio
async def test_analyze_frame_with_mock_client() -> None:
    dummy_response = {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "content": json.dumps({
                        "hazard": {
                            "type": "pole",
                            "direction": "left",
                            "distance": "near",
                            "clear_side": "right",
                            "urgency": 2,
                            "confidence": 0.95,
                        },
                    })
                },
            }
        ],
        "usage": {"prompt_tokens": 328, "completion_tokens": 40},
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=dummy_response, request=req))
    result, usage, latency, timings = await analyze_frame(
        b"dummyimage", lang="en", client=mock_http
    )
    assert result.status == "hazard"
    assert result.instruction == "Pole left, step right"
    assert usage["input_tokens"] == 328
    assert usage["finish_reason"] == "stop"
    assert latency >= 0.0
    assert "meta_call_start" in timings
    assert "meta_call_end" in timings


@pytest.mark.asyncio
async def test_truncated_response_retries_and_returns_unknown_if_still_truncated() -> None:
    reset_parse_failures()
    reset_perception_stats()
    # Mock where both attempts (800 and 1200 tokens) hit finish_reason="length"
    length_response = {
        "choices": [
            {
                "finish_reason": "length",
                "message": {"content": ""},
            }
        ],
        "usage": {
            "prompt_tokens": 328,
            "completion_tokens": 800,
            "completion_tokens_details": {"reasoning_tokens": 150},
        },
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(return_value=Response(200, json=length_response, request=req))

    result, usage, _, _ = await analyze_frame(
        b"dummyimage", lang="en", client=mock_http
    )

    assert mock_http.post.call_count == 2
    # First attempt: max_tokens=800
    assert mock_http.post.call_args_list[0].kwargs["json"]["max_tokens"] == 800
    # Second attempt: max_tokens=1200
    assert mock_http.post.call_args_list[1].kwargs["json"]["max_tokens"] == 1200

    assert result.status == "unknown"
    assert result.instruction == "unknown"
    assert result.path_clear is False
    assert usage["finish_reason"] == "length"
    assert usage["retries_display"] == "1 / 1"
    assert usage["median_reasoning_tokens"] == 150.0


@pytest.mark.asyncio
async def test_retry_recovers_when_first_attempt_truncated() -> None:
    reset_parse_failures()
    reset_perception_stats()
    first_response = {
        "choices": [
            {
                "finish_reason": "length",
                "message": {"content": ""},
            }
        ],
        "usage": {
            "prompt_tokens": 328,
            "completion_tokens": 800,
            "completion_tokens_details": {"reasoning_tokens": 200},
        },
    }
    second_response = {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "content": json.dumps({
                        "hazard": {
                            "type": "pole",
                            "direction": "center",
                            "distance": "near",
                            "urgency": 2,
                        },
                    }),
                },
            }
        ],
        "usage": {
            "prompt_tokens": 328,
            "completion_tokens": 480,
            "completion_tokens_details": {"reasoning_tokens": 100},
        },
    }

    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(
        side_effect=[
            Response(200, json=first_response, request=req),
            Response(200, json=second_response, request=req),
        ]
    )

    result, usage, _, _ = await analyze_frame(
        b"dummyimage", lang="en", client=mock_http
    )

    assert mock_http.post.call_count == 2
    assert mock_http.post.call_args_list[0].kwargs["json"]["max_tokens"] == 800
    assert mock_http.post.call_args_list[1].kwargs["json"]["max_tokens"] == 1200
    assert result.status == "hazard"
    assert result.hazard is not None
    assert result.hazard.type == "pole"
    assert usage["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_frame_endpoint() -> None:
    fake_perception = PerceptionResult(
        status="hazard",
        hazard=None,
        hazards=[],
        path_clear=False,
        instruction="Pole ahead, step left",
        signage_text=[],
    )
    fake_usage = {
        "input_tokens": 328,
        "output_tokens": 40,
        "est_cost_usd": 0.002,
        "finish_reason": "stop",
    }
    fake_timings = {"meta_call_start": 1730300000.2, "meta_call_end": 1730300000.4}
    mock_analyze = AsyncMock(return_value=(fake_perception, fake_usage, 280.5, fake_timings))

    transport = ASGITransport(app=app)
    with patch("server.app.analyze_frame", mock_analyze):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            files = {"file": ("test.jpg", b"\xff\xd8\xff\xe0testimagebytes", "image/jpeg")}
            data = {"timestamp": "1730300000.123", "lang": "en"}
            resp = await client.post("/frame", files=files, data=data)
            assert resp.status_code == 200
            body = resp.json()
            assert "perception" in body
            assert body["perception"]["instruction"] == "Pole ahead, step left"
            assert body["perception"]["status"] == "hazard"
            assert body["usage"]["input_tokens"] == 328
            assert body["finish_reason"] == "stop"
            assert body["client_timestamp"] == 1730300000.123
            assert body["retries_display"] == "0 / 0"
            assert body["median_reasoning_tokens"] == 0.0
            assert "server_total_ms" in body
            assert "meta_ms" in body


def test_chair_center_specific_phrase() -> None:
    # 1. chair center, clear_side right -> "कुर्सी आगे, दाएँ हटें" (hi) / "Chair ahead, step right" (en)
    assert (
        build_phrase("chair", direction="center", clear_side="right", lang="hi")
        == "कुर्सी आगे, दाएँ हटें"
    )
    assert (
        build_phrase("chair", direction="center", clear_side="right", lang="en")
        == "Chair ahead, step right"
    )

    # 2. chair center, clear_side left
    assert (
        build_phrase("chair", direction="center", clear_side="left", lang="hi")
        == "कुर्सी आगे, बाएँ हटें"
    )
    assert (
        build_phrase("chair", direction="center", clear_side="left", lang="en")
        == "Chair ahead, step left"
    )

    # 3. chair center, clear_side none
    assert (
        build_phrase("chair", direction="center", clear_side="none", lang="hi")
        == "कुर्सी आगे, रुकें"
    )
    assert (
        build_phrase("chair", direction="center", clear_side="none", lang="en")
        == "Chair ahead, stop"
    )

    # Via parse_perception_response
    raw = json.dumps({
        "hazard": {
            "type": "chair",
            "direction": "center",
            "clear_side": "right",
            "urgency": 2,
            "confidence": 0.95,
        }
    })
    res_hi = parse_perception_response(raw, lang="hi")
    assert res_hi.instruction == "कुर्सी आगे, दाएँ हटें"
    res_en = parse_perception_response(raw, lang="en")
    assert res_en.instruction == "Chair ahead, step right"


def test_other_with_label() -> None:
    # "other" with a label speaks "{label} आगे, रुकें" for center static hazards
    assert (
        build_phrase("other", direction="center", clear_side="none", label="कार्ट", lang="hi")
        == "कार्ट आगे, रुकें"
    )
    assert (
        build_phrase("other", direction="center", clear_side="none", label="cart", lang="en")
        == "cart ahead, stop"
    )

    # With clear_side
    assert (
        build_phrase("other", direction="center", clear_side="right", label="कार्ट", lang="hi")
        == "कार्ट आगे, दाएँ हटें"
    )
    assert (
        build_phrase("other", direction="center", clear_side="right", label="cart", lang="en")
        == "cart ahead, step right"
    )

    # Via parse_perception_response
    raw = json.dumps({
        "hazard": {
            "type": "other",
            "direction": "center",
            "clear_side": "none",
            "label": "कार्ट",
            "urgency": 1,
            "confidence": 0.95,
        }
    })
    res_hi = parse_perception_response(raw, lang="hi")
    assert res_hi.instruction == "कार्ट आगे, रुकें"
    assert res_hi.hazards[0].label == "कार्ट"


def test_other_without_label() -> None:
    # "other" without a label uses generic word for "hazard"
    assert (
        build_phrase("other", direction="center", clear_side="none", label=None, lang="hi")
        == "खतरा आगे, रुकें"
    )
    assert (
        build_phrase("other", direction="center", clear_side="none", label=None, lang="en")
        == "Hazard ahead, stop"
    )

    # With clear_side
    assert (
        build_phrase("other", direction="center", clear_side="right", label=None, lang="hi")
        == "खतरा आगे, दाएँ हटें"
    )
    assert (
        build_phrase("other", direction="center", clear_side="right", label=None, lang="en")
        == "Hazard ahead, step right"
    )

    # Via parse_perception_response
    raw = json.dumps({
        "hazard": {
            "type": "other",
            "direction": "center",
            "clear_side": "none",
            "label": None,
            "urgency": 1,
            "confidence": 0.95,
        }
    })
    res_hi = parse_perception_response(raw, lang="hi")
    assert res_hi.instruction == "खतरा आगे, रुकें"


def test_never_path_clear() -> None:
    # Hard Rule 1: Never speak "path clear" or imply safety
    assert build_phrase(None, lang="en") == ""
    assert build_phrase(None, lang="hi") == ""
    assert build_phrase("", lang="en") == ""

    # Valid parse with empty hazards produces empty instruction
    raw = json.dumps({"hazard": None, "hazards": []})
    res = parse_perception_response(raw, lang="en")
    assert res.status == "clear"
    assert res.instruction == ""
    assert "clear" not in res.instruction.lower()


def test_expanded_hazard_types_and_clear_sides() -> None:
    expected_types = [
        "chair", "table", "bench", "door", "wall", "pole", "tree_branch",
        "vehicle", "rickshaw", "bicycle", "person", "animal", "stairs",
        "step_down", "pothole", "open_drain", "construction", "other",
    ]
    for t in expected_types:
        h = Hazard(type=t, direction="center", clear_side="right", label="test")
        assert h.type == t
        assert h.clear_side == "right"
        phrase_hi = build_phrase(t, "center", "right", lang="hi")
        phrase_en = build_phrase(t, "center", "right", lang="en")
        assert len(phrase_hi.split()) <= 4
        assert len(phrase_en.split()) <= 4
        assert phrase_hi != ""
        assert phrase_en != ""


def test_system_messages_camera_blocked_and_clear() -> None:
    # Camera blocked or too close, stop (Req Item 5)
    assert get_system_message("camera_blocked", lang="en") == "Camera blocked or too close, stop"
    assert get_system_message("camera_blocked", lang="hi") == "कैमरा बंद या बहुत पास, रुकें"

    # Camera clear
    assert get_system_message("camera_clear", lang="en") == "Camera clear"
    assert get_system_message("camera_clear", lang="hi") == "कैमरा साफ़"

    # Vision limited moving only
    assert (
        get_system_message("vision_limited_moving_only", lang="en")
        == "Vision limited, moving-object alerts only"
    )
    assert (
        get_system_message("vision_limited_moving_only", lang="hi")
        == "दृष्टि सीमित, केवल गतिमान वस्तुएँ"
    )


@pytest.mark.asyncio
async def test_status_endpoint() -> None:
    reset_perception_stats()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "retries" in data
        assert "total_frames" in data
        assert "retries_display" in data
        assert "median_reasoning_tokens" in data
        assert "spend" in data


@pytest.mark.asyncio
async def test_high_retry_warning_logged(caplog: pytest.LogCaptureFixture) -> None:
    reset_perception_stats()
    # Mock where first attempt fails (triggering retry)
    first_response = {
        "choices": [{"finish_reason": "length", "message": {"content": ""}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 800},
    }
    second_response = {
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json.dumps({"hazard": None})},
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
    }
    mock_http = AsyncMock()
    req = httpx.Request("POST", "http://test")
    mock_http.post = AsyncMock(
        side_effect=[
            Response(200, json=first_response, request=req),
            Response(200, json=second_response, request=req),
        ]
    )

    with caplog.at_level("WARNING"):
        await analyze_frame(b"dummyimage", client=mock_http)

    stats = get_perception_stats()
    assert stats["total_frames"] == 1
    assert stats["retry_frames"] == 1
    assert stats["retries_display"] == "1 / 1"
    # 1 retry out of 1 frame is 100% > 10%
    assert any("High Tier 2 retry rate" in record.message for record in caplog.records)


def test_system_prompt_shortened() -> None:
    # Verify system prompt asks for single most urgent hazard only and has one-line JSON example
    assert "single most urgent" in SYSTEM_PROMPT.lower()
    assert '{"hazard":null}' in SYSTEM_PROMPT
    assert '{"hazard":{"type":' in SYSTEM_PROMPT

