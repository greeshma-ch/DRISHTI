"""Fixed phrase table for P1 hazard alerts — English and Hindi (AGENTS.md rule).

Hard Rule 1: Never claim a path or crossing is safe. Report detections only.
All phrases are 4 words or fewer: action + direction or detection + avoid action.
"""

from __future__ import annotations

NOUNS: dict[str, dict[str, str]] = {
    "chair": {"en": "Chair", "hi": "कुर्सी"},
    "table": {"en": "Table", "hi": "मेज़"},
    "bench": {"en": "Bench", "hi": "बेंच"},
    "door": {"en": "Door", "hi": "दरवाज़ा"},
    "wall": {"en": "Wall", "hi": "दीवार"},
    "pole": {"en": "Pole", "hi": "खंभा"},
    "tree_branch": {"en": "Branch", "hi": "टहनी"},
    "vehicle": {"en": "Vehicle", "hi": "गाड़ी"},
    "rickshaw": {"en": "Rickshaw", "hi": "रिक्शा"},
    "bicycle": {"en": "Bicycle", "hi": "साइकिल"},
    "person": {"en": "Person", "hi": "व्यक्ति"},
    "animal": {"en": "Animal", "hi": "जानवर"},
    "stairs": {"en": "Stairs", "hi": "सीढ़ियां"},
    "step_down": {"en": "Step down", "hi": "सीढ़ी"},
    "pothole": {"en": "Pothole", "hi": "गड्ढा"},
    "open_drain": {"en": "Drain", "hi": "नाला"},
    "construction": {"en": "Construction", "hi": "निर्माण"},
    "other": {"en": "Hazard", "hi": "खतरा"},
}

DIRECTIONS: dict[str, dict[str, str]] = {
    "center": {"en": "ahead", "hi": "आगे"},
    "left": {"en": "left", "hi": "बाएँ"},
    "right": {"en": "right", "hi": "दाएँ"},
}

AVOID_ACTIONS: dict[str, dict[str, str]] = {
    "right": {"en": "step right", "hi": "दाएँ हटें"},
    "left": {"en": "step left", "hi": "बाएँ हटें"},
}


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
