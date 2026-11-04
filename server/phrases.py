"""Fixed phrase table for P1 hazard alerts — English and Hindi (AGENTS.md rule).

Hard Rule 1: Never claim a path or crossing is safe. Report detections only.
Hard Rule 8: Never instruct a lateral move (step left/right) for vehicles, people,
bicycles or animals. Moving things get a caution word plus position.
All phrases are 4 words or fewer.
"""

from __future__ import annotations

import json
from pathlib import Path

# Load phrase tables from shared/phrases.json (single source of truth)
_SHARED_PHRASES_PATH = Path(__file__).parent.parent / "shared" / "phrases.json"

with _SHARED_PHRASES_PATH.open("r", encoding="utf-8") as f:
    _PHRASES = json.load(f)

NOUNS: dict[str, dict[str, str]] = _PHRASES["nouns"]
DIRECTIONS: dict[str, dict[str, str]] = _PHRASES["directions"]
AVOID_ACTIONS: dict[str, dict[str, str]] = _PHRASES["avoid_actions"]
SYSTEM_MESSAGES: dict[str, dict[str, str]] = _PHRASES["system_messages"]
MOVING_HAZARDS: set[str] = set(
    _PHRASES.get("moving_hazards", ["vehicle", "person", "bicycle", "animal", "rickshaw"])
)
CAUTION_ACTIONS: dict[str, dict[str, str]] = _PHRASES.get("caution_actions", {})


def build_phrase(
    hazard_type: str | None,
    direction: str = "center",
    clear_side: str = "none",
    label: str | None = None,
    lang: str = "en",
    confidence: float = 1.0,
) -> str:
    """Build a fixed alert phrase of <= 4 words in Hindi or English.

    Hard Rule 1: Never returns 'path clear' or implies safety.
    Hard Rule 8: Never instruct a lateral move for moving objects.
    Returns '' if no hazard.

    Low confidence (< 0.6): prefix with "possible " / "संभावित "
    Exception: Never add "possible" to a Stop phrase (e.g., "Vehicle ahead, stop" stays as-is)
    """
    if not hazard_type:
        return ""

    lang_code = "hi" if str(lang).lower().startswith("hi") else "en"

    # 1. Determine noun
    h_type = str(hazard_type).lower().strip()
    if h_type == "other" and label and str(label).strip():
        words = str(label).strip().split()
        noun = " ".join(words[:2])
    else:
        noun_info = NOUNS.get(h_type, NOUNS["other"])
        noun = noun_info[lang_code]

    dir_code = str(direction).lower().strip()
    if dir_code not in DIRECTIONS:
        dir_code = "center"

    # 2. Moving hazard (Hard Rule 8: Caution word plus position; NO steering)
    if h_type in MOVING_HAZARDS:
        if dir_code == "center":
            phrase = f"{noun} आगे, रुकें" if lang_code == "hi" else f"{noun} ahead, stop"
        elif dir_code == "left":
            phrase = f"{noun} बाएँ, सावधान" if lang_code == "hi" else f"{noun} on left, careful"
        elif dir_code == "right":
            phrase = f"{noun} दाएँ, सावधान" if lang_code == "hi" else f"{noun} on right, careful"

        # Apply hedged wording for low confidence
        # But NEVER add "possible" to a Stop phrase (phrases ending with "stop" or "रुकें")
        if confidence < 0.6:
            if lang_code == "en" and not phrase.endswith("stop"):
                phrase = f"possible {phrase}"
            elif lang_code == "hi" and not phrase.endswith("रुकें"):
                phrase = f"संभावित {phrase}"

        # Ensure <= 4 words
        words = phrase.split()
        return " ".join(words[:4])

    # 3. Static obstacle: steering allowed only if clear_side provided
    dir_info = DIRECTIONS.get(dir_code, DIRECTIONS["center"])
    dir_word = dir_info[lang_code]

    clear_code = str(clear_side).lower().strip()
    avoid_info = AVOID_ACTIONS.get(clear_code)

    if avoid_info:
        avoid_action = avoid_info[lang_code]
        # For multi-word nouns like "Step down" in English, avoid exceeding 4 words
        if lang_code == "en" and h_type == "step_down":
            candidate = f"Step down, {avoid_action}"
        else:
            candidate = f"{noun} {dir_word}, {avoid_action}"
        if len(candidate.split()) <= 4:
            phrase = candidate
        else:
            phrase = f"{noun} {dir_word}"
    else:
        phrase = f"{noun} {dir_word}"

    # Apply hedged wording for low confidence
    if confidence < 0.6:
        if lang_code == "en" and not phrase.endswith("stop"):
            phrase = f"possible {phrase}"
        elif lang_code == "hi" and not phrase.endswith("रुकें"):
            phrase = f"संभावित {phrase}"

    words = phrase.split()
    return " ".join(words[:4])


def get_system_message(key: str, lang: str = "en") -> str:
    """Get a system message in the given language."""
    msg = SYSTEM_MESSAGES.get(key)
    if not msg:
        return ""
    lang_code = "hi" if str(lang).lower().startswith("hi") else "en"
    return msg[lang_code]
