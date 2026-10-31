"""Fixed phrase table for P1 hazard alerts — English and Hindi (AGENTS.md rule).

Hard Rule 1: Never claim a path or crossing is safe. Report detections only.
All phrases are 4 words or fewer: action + direction or detection + avoid action.
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


def build_phrase(
    hazard_type: str | None,
    direction: str = "center",
    clear_side: str = "none",
    label: str | None = None,
    lang: str = "en",
) -> str:
    """Build a fixed alert phrase of <= 4 words in Hindi or English.

    Hard Rule 1: Never returns 'path clear' or implies safety.
    Returns '' if no hazard.
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
            return candidate

    base = f"{noun} {dir_word}"
    words = base.split()
    return " ".join(words[:4])


def get_system_message(key: str, lang: str = "en") -> str:
    """Get a system message (vision_paused, vision_back, vision_limited, etc.) in the given language."""
    msg = SYSTEM_MESSAGES.get(key)
    if not msg:
        return ""
    lang_code = "hi" if str(lang).lower().startswith("hi") else "en"
    return msg[lang_code]