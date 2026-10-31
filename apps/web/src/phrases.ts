// Phrase table loaded from shared/phrases.json — single source of truth for client & server
import phrasesJson from "@shared/phrases.json";

// Type definitions matching the JSON structure
export interface PhraseNoun {
  en: string;
  hi: string;
}

export interface PhraseDirection {
  en: string;
  hi: string;
}

export interface PhraseAvoidAction {
  en: string;
  hi: string;
}

export interface SystemMessage {
  en: string;
  hi: string;
}

export interface PhraseTables {
  nouns: Record<string, PhraseNoun>;
  directions: Record<string, PhraseDirection>;
  avoid_actions: Record<string, PhraseAvoidAction>;
  system_messages: Record<string, SystemMessage>;
}

// Load from shared JSON
const PHRASES: PhraseTables = phrasesJson as PhraseTables;

export const NOUNS = PHRASES.nouns;
export const DIRECTIONS = PHRASES.directions;
export const AVOID_ACTIONS = PHRASES.avoid_actions;
export const SYSTEM_MESSAGES = PHRASES.system_messages;

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

// Helper to get system messages in the current language
export const getSystemMessage = (key: string, language: "en" | "hi"): string => {
  const msg = SYSTEM_MESSAGES[key];
  if (!msg) return "";
  return language === "hi" ? msg.hi : msg.en;
};