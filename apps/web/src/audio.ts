/** Audio clip manager — plays pre-rendered clips with TTS fallback. */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

interface AudioManifest {
  version: number;
  clips: {
    hazards: Record<string, string>;
    system: Record<string, string>;
  };
}

let manifest: AudioManifest | null = null;
let manifestLoadPromise: Promise<AudioManifest> | null = null;
let activeAudio: HTMLAudioElement | null = null;
let audioRequestId = 0;

export function stopClip(): void {
  audioRequestId += 1;
  if (!activeAudio) return;
  const audio = activeAudio;
  activeAudio = null;
  audio.pause();
  audio.currentTime = 0;
}

/** Load the audio manifest from /audio/manifest.json */
async function loadManifest(): Promise<AudioManifest> {
  if (manifest) return manifest;
  if (manifestLoadPromise) return manifestLoadPromise;

  manifestLoadPromise = (async () => {
    try {
      const resp = await fetch("/audio/manifest.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      manifest = await resp.json();
      return manifest!;
    } catch (err) {
      console.warn("[Audio] Failed to load manifest, using TTS only:", err);
      manifest = { version: 0, clips: { hazards: {}, system: {} } };
      return manifest;
    }
  })();

  return manifestLoadPromise;
}

/** Build the audio clip key for a hazard phrase */
export function getHazardClipKey(
  hazardType: string,
  direction: string,
  clearSide: string
): string {
  const type = hazardType.toLowerCase().trim();
  const dir = direction.toLowerCase().trim();
  const side = clearSide.toLowerCase().trim();
  return `${type}:${dir}:${side}`;
}

/** Build the audio clip key for a system message */
export function getSystemClipKey(key: string): string {
  return key;
}

/** Play a pre-rendered audio clip if available, otherwise fall back to TTS */
export async function playClipOrTTS(
  text: string,
  language: "en" | "hi",
  clipKey: string,
  clipType: "hazards" | "system",
  ttsSpeakFn: (text: string, language: "en" | "hi") => void,
  onStart: () => void = () => {},
  onEnd: () => void = () => {}
): Promise<boolean> {
  const requestId = ++audioRequestId;
  await loadManifest();
  if (requestId !== audioRequestId) return false;

  const filename = manifest?.clips[clipType]?.[clipKey];
  if (!filename) {
    ttsSpeakFn(text, language);
    return false;
  }

  const audioUrl = `/audio/${language}/${filename}`;
  let audio: HTMLAudioElement | null = null;
  let started = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (activeAudio === audio) activeAudio = null;
    onEnd();
  };

  try {
    audio = new Audio(audioUrl);
    activeAudio = audio;
    audio.onplay = () => {
      if (!started) {
        started = true;
        onStart();
      }
    };
    audio.onended = finish;
    audio.onerror = () => {
      if (activeAudio === audio) activeAudio = null;
      if (!started) ttsSpeakFn(text, language);
      else finish();
    };
    await audio.play();
    return true;
  } catch (err) {
    console.warn(`[Audio] Failed to play clip ${audioUrl}, falling back to TTS:`, err);
    if (activeAudio === audio) activeAudio = null;
    if (requestId === audioRequestId) ttsSpeakFn(text, language);
    return false;
  }
}

/** Check if a pre-rendered clip exists for the given key (without playing) */
export async function hasClip(clipKey: string, clipType: "hazards" | "system"): Promise<boolean> {
  await loadManifest();
  return !!manifest?.clips[clipType]?.[clipKey];
}

/** Preload an audio clip (for faster playback later) */
export async function preloadClip(clipKey: string, clipType: "hazards" | "system", language: "en" | "hi"): Promise<void> {
  await loadManifest();
  const filename = manifest?.clips[clipType]?.[clipKey];
  if (!filename) return;

  const audioUrl = `/audio/${language}/${filename}`;
  // Create an audio element and let it load
  const audio = new Audio(audioUrl);
  audio.preload = "auto";
  try {
    await audio.load();
  } catch {
    // Ignore preload errors
  }
}

/** Play a soft tick sound (for periodic reassurance that system is active).
 * Generates a short, gentle sine wave tone using Web Audio API. */
export function playSoftTick(): void {
  try {
    const ctx = getAudioContext();
    // Resume context if suspended (browser autoplay policy)
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(800, ctx.currentTime); // 800 Hz - gentle tone
    // Quick fade in/out for a soft "tick" feel
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.01); // 10ms attack
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15); // 150ms decay

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.2); // Stop after 200ms
  } catch (err) {
    console.warn("[Audio] Failed to play soft tick:", err);
  }
}