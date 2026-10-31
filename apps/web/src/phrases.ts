export const NOUNS: Record<string, { en: string; hi: string }> = {
  chair: { en: "Chair", hi: "कुर्सी" },
  table: { en: "Table", hi: "मेज़" },
  bench: { en: "Bench", hi: "बेंच" },
  door: { en: "Door", hi: "दरवाज़ा" },
  wall: { en: "Wall", hi: "दीवार" },
  pole: { en: "Pole", hi: "खंभा" },
  tree_branch: { en: "Branch", hi: "टहनी" },
  vehicle: { en: "Vehicle", hi: "गाड़ी" },
  rickshaw: { en: "Rickshaw", hi: "रिक्शा" },
  bicycle: { en: "Bicycle", hi: "साइकिल" },
  person: { en: "Person", hi: "व्यक्ति" },
  animal: { en: "Animal", hi: "जानवर" },
  stairs: { en: "Stairs", hi: "सीढ़ियां" },
  step_down: { en: "Step down", hi: "सीढ़ी" },
  pothole: { en: "Pothole", hi: "गड्ढा" },
  open_drain: { en: "Drain", hi: "नाला" },
  construction: { en: "Construction", hi: "निर्माण" },
  other: { en: "Hazard", hi: "खतरा" },
};

export const DIRECTIONS: Record<string, { en: string; hi: string }> = {
  center: { en: "ahead", hi: "आगे" },
  left: { en: "left", hi: "बाएँ" },
  right: { en: "right", hi: "दाएँ" },
};

export const AVOID_ACTIONS: Record<string, { en: string; hi: string }> = {
  right: { en: "step right", hi: "दाएँ हटें" },
  left: { en: "step left", hi: "बाएँ हटें" },
};

export const buildPhrase = (
  hazard: {
    type?: string | null;
    direction?: string | null;
    clear_side?: string | null;
    label?: string | null;
  } | null,
  language: "en" | "hi"
): string => {
  if (!hazard || !hazard.type) {
    return ""; // Never speak "path clear" or imply safety (Hard Rule 1)
  }

  const langCode = language === "hi" ? "hi" : "en";
  const hType = hazard.type.toLowerCase().trim();

  // 1. Determine noun
  let noun: string;
  if (hType === "other" && hazard.label && hazard.label.trim()) {
    const words = hazard.label.trim().split(/\s+/);
    noun = words.slice(0, 2).join(" ");
  } else {
    const nounInfo = NOUNS[hType] ?? NOUNS.other!;
    noun = nounInfo[langCode];
  }

  // 2. Direction
  const dirCode = (hazard.direction || "center").toLowerCase().trim();
  const dirInfo = DIRECTIONS[dirCode] ?? DIRECTIONS.center!;
  const dirWord = dirInfo[langCode];

  // 3. Avoid action from clear_side
  const clearCode = (hazard.clear_side || "none").toLowerCase().trim();
  const avoidInfo = AVOID_ACTIONS[clearCode];

  if (avoidInfo) {
    const avoidAction = avoidInfo[langCode];
    let candidate: string;
    if (langCode === "en" && hType === "step_down") {
      candidate = `Step down, ${avoidAction}`;
    } else {
      candidate = `${noun} ${dirWord}, ${avoidAction}`;
    }
    if (candidate.split(/\s+/).length <= 4) {
      return candidate;
    }
  }

  const base = `${noun} ${dirWord}`;
  const words = base.split(/\s+/);
  return words.slice(0, 4).join(" ");
};

