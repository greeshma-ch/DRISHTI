"""Tests for hedged wording (P4)."""

from __future__ import annotations

from server.phrases import build_phrase


def test_low_confidence_prefixes_possible_en() -> None:
    """Confidence < 0.6: phrase prefixed with 'possible ' in English."""
    # Static hazard with low confidence - truncated to 4 words
    phrase = build_phrase("pole", direction="left", clear_side="right", lang="en", confidence=0.4)
    assert phrase == "possible Pole left, step"  # Truncated to 4 words

    # Another static hazard - truncated to 4 words
    phrase = build_phrase("chair", direction="center", clear_side="right", lang="en", confidence=0.3)
    assert phrase == "possible Chair ahead, step"  # Truncated to 4 words

    # Center static hazards use an unhedged stop phrase
    phrase = build_phrase("pole", direction="center", clear_side="none", lang="en", confidence=0.5)
    assert phrase == "Pole ahead, stop"


def test_low_confidence_prefixes_sambhavit_hi() -> None:
    """Confidence < 0.6: phrase prefixed with 'संभावित ' in Hindi."""
    # Static hazard with low confidence - truncated to 4 words
    phrase = build_phrase("pole", direction="left", clear_side="right", lang="hi", confidence=0.4)
    assert phrase == "संभावित खंभा बाएँ, दाएँ"  # Truncated to 4 words

    # Another static hazard - truncated to 4 words
    phrase = build_phrase("chair", direction="center", clear_side="right", lang="hi", confidence=0.3)
    assert phrase == "संभावित कुर्सी आगे, दाएँ"  # Truncated to 4 words


def test_normal_confidence_no_prefix() -> None:
    """Confidence >= 0.6: no prefix added."""
    phrase = build_phrase("pole", direction="left", clear_side="right", lang="en", confidence=0.6)
    assert phrase == "Pole left, step right"
    assert not phrase.startswith("possible")

    phrase = build_phrase("pole", direction="left", clear_side="right", lang="en", confidence=0.95)
    assert phrase == "Pole left, step right"


def test_stop_phrase_never_gets_possible_en() -> None:
    """Stop phrases (vehicle center, etc.) never get 'possible' prefix in English."""
    # Vehicle center -> "Vehicle ahead, stop" - should NOT have "possible"
    phrase = build_phrase("vehicle", direction="center", lang="en", confidence=0.4)
    assert phrase == "Vehicle ahead, stop"
    assert not phrase.startswith("possible")

    # Person center
    phrase = build_phrase("person", direction="center", lang="en", confidence=0.3)
    assert phrase == "Person ahead, stop"
    assert not phrase.startswith("possible")

    # Bicycle center
    phrase = build_phrase("bicycle", direction="center", lang="en", confidence=0.2)
    assert phrase == "Bicycle ahead, stop"
    assert not phrase.startswith("possible")

    # Animal center
    phrase = build_phrase("animal", direction="center", lang="en", confidence=0.1)
    assert phrase == "Animal ahead, stop"
    assert not phrase.startswith("possible")

    # Rickshaw center
    phrase = build_phrase("rickshaw", direction="center", lang="en", confidence=0.4)
    assert phrase == "Rickshaw ahead, stop"
    assert not phrase.startswith("possible")


def test_stop_phrase_never_gets_possible_hi() -> None:
    """Stop phrases never get 'संभावित' prefix in Hindi."""
    # Vehicle center -> "गाड़ी आगे, रुकें" - should NOT have "संभावित"
    phrase = build_phrase("vehicle", direction="center", lang="hi", confidence=0.4)
    assert phrase == "गाड़ी आगे, रुकें"
    assert not phrase.startswith("संभावित")

    # Person center
    phrase = build_phrase("person", direction="center", lang="hi", confidence=0.3)
    assert phrase == "व्यक्ति आगे, रुकें"
    assert not phrase.startswith("संभावित")


def test_moving_hazard_side_gets_possible() -> None:
    """Moving hazard on side (not center) DOES get 'possible' prefix with low confidence."""
    # Vehicle left -> "Vehicle on left, careful" - SHOULD get "possible" (truncated to 4 words)
    phrase = build_phrase("vehicle", direction="left", lang="en", confidence=0.4)
    assert phrase == "possible Vehicle on left,"  # Truncated to 4 words (comma part of word)

    # Vehicle right
    phrase = build_phrase("vehicle", direction="right", lang="en", confidence=0.4)
    assert phrase == "possible Vehicle on right,"  # Truncated to 4 words

    # Person left
    phrase = build_phrase("person", direction="left", lang="en", confidence=0.3)
    assert phrase == "possible Person on left,"  # Truncated to 4 words


def test_phrase_length_max_4_words() -> None:
    """Phrase length <= 4 words after hedging."""
    # Test various phrases with low confidence
    test_cases = [
        ("pole", "left", "right", "en"),
        ("chair", "center", "right", "en"),
        ("step_down", "center", "left", "en"),
        ("vehicle", "left", "none", "en"),
        ("person", "right", "none", "en"),
        ("pole", "left", "right", "hi"),
        ("chair", "center", "right", "hi"),
    ]

    for hazard_type, direction, clear_side, lang in test_cases:
        phrase = build_phrase(hazard_type, direction=direction, clear_side=clear_side, lang=lang, confidence=0.4)
        words = phrase.split()
        assert len(words) <= 4, f"Phrase '{phrase}' has {len(words)} words (max 4)"


def test_hedged_wording_via_parse_perception() -> None:
    """Integration test: hedged wording through parse_perception_response."""
    import json

    from server.meta_client import parse_perception_response

    # Low confidence hazard - truncated to 4 words
    raw = json.dumps({
        "hazard": {
            "type": "pole",
            "direction": "left",
            "distance": "near",
            "clear_side": "right",
            "urgency": 2,
            "confidence": 0.4,
        }
    })
    result = parse_perception_response(raw, lang="en")
    assert result.status == "hazard"
    assert result.instruction == "possible Pole left, step"  # Truncated to 4 words
    assert result.hazard.confidence == 0.4

    # Normal confidence
    raw = json.dumps({
        "hazard": {
            "type": "pole",
            "direction": "left",
            "distance": "near",
            "clear_side": "right",
            "urgency": 2,
            "confidence": 0.8,
        }
    })
    result = parse_perception_response(raw, lang="en")
    assert result.instruction == "Pole left, step right"
    assert not result.instruction.startswith("possible")

    # Low confidence stop phrase (vehicle center)
    raw = json.dumps({
        "hazard": {
            "type": "vehicle",
            "direction": "center",
            "distance": "near",
            "clear_side": "none",
            "urgency": 3,
            "confidence": 0.4,
        }
    })
    result = parse_perception_response(raw, lang="en")
    assert result.instruction == "Vehicle ahead, stop"
    assert not result.instruction.startswith("possible")
