/** Priority Arbiter — core message queue with interrupt semantics (AGENTS.md). */

import { SYSTEM_MESSAGES } from "./phrases";

export type Priority = 0 | 1 | 2 | 3; // P0=emergency, P1=hazard, P2=nav, P3=advisory

export type ArbiterDecision =
  | { type: "interrupt"; reason: "P0" | "P1_interrupts_P2" | "P1_interrupts_P3" | "status_interrupts_P1" | "P1_urgency3_interrupts_P1" }
  | { type: "deferred"; reason: "rate_limit" | "P1_active" | "P0_active" | "P1_queued_as_next" | "recovery_waiting_for_hazard" }
  | { type: "dropped"; reason: "ttl_expired" | "dedupe" | "rate_limit_enqueue" | "rate_limit_deferred_interrupt" | "queue_limit" | "recovery_timeout" }
  | { type: "spoken"; reason: "normal" | "interrupt" | "P0_immediate" | "recovery_after_hazard" | "recovery_immediate" };

export interface ArbiterMessage {
  priority: Priority;
  text: string;
  ttlMs: number;
  key: string; // dedupe key, e.g. "hazard:chair:center", "status:vision_paused"
  language: "en" | "hi";
  timestamp: number;
  responseReceivedPerfMs?: number; // for speech timing
  isStatus?: boolean; // true for Vision paused/back/limited - not held by hazards > 3s
  isRecovery?: boolean;
  clipKey?: string; // audio manifest key for pre-rendered clip
  clipType?: "hazards" | "system"; // audio manifest section
  urgency?: number; // 0-3, for P1 hazards: higher = more urgent (3 = highest, e.g., vehicle approaching)
}

export interface ArbiterConfig {
  hazardDedupeMs: number; // 4000
  hazardMinIntervalMs: number; // 1500
  hazardTtlMs: number; // 2000
  navTtlMs: number; // longer for nav cues
  advisoryTtlMs: number; // longer for chat
  statusMaxWaitMs: number; // max wait for status msg when P1 hazard speaking
  onDecision?: (decision: ArbiterDecision, message?: ArbiterMessage) => void;
}

const DEFAULT_CONFIG: ArbiterConfig = {
  hazardDedupeMs: 4000,
  hazardMinIntervalMs: 1500,
  hazardTtlMs: 2000,
  navTtlMs: 10000,
  advisoryTtlMs: 15000,
  statusMaxWaitMs: 3000, // status messages not held by hazards > 3s
};

export class PriorityArbiter {
  private queue: ArbiterMessage[] = [];
  private lastSpokenAt = 0;
  private lastSpokenKey = "";
  private lastSpokenPriority = 3;
  private lastSpokenUrgency = 0;
  private lastSpokenAtByP1Key = new Map<string, number>();
  private lastHazardSpokenAt = -Infinity;
  private config: ArbiterConfig;
  private speakFn: (
    text: string,
    language: "en" | "hi",
    key: string,
    responseReceivedPerfMs?: number,
    clipKey?: string,
    clipType?: "hazards" | "system"
  ) => void;
  private cancelFn: (priority?: Priority) => void;
  private isSpeaking = false;
  private currentUtterancePriority = 3;

  constructor(
    speakFn: (
      text: string,
      language: "en" | "hi",
      key: string,
      responseReceivedPerfMs?: number,
      clipKey?: string,
      clipType?: "hazards" | "system"
    ) => void,
    cancelFn: (priority?: Priority) => void,
    config: Partial<ArbiterConfig> = {}
  ) {
    this.speakFn = speakFn;
    this.cancelFn = cancelFn;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private emitDecision(decision: ArbiterDecision, message?: ArbiterMessage): void {
    this.config.onDecision?.(decision, message);
  }

  /** Enqueue a message. Returns true if accepted (not dropped by TTL). */
  enqueue(msg: ArbiterMessage): boolean {
    const now = Date.now();

    // P0: emergency — never queued, speak immediately
    if (msg.priority === 0) {
      this.cancelFn(0);
      this.speakFn(msg.text, msg.language, msg.key, msg.responseReceivedPerfMs, msg.clipKey, msg.clipType);
      this.lastSpokenAt = now;
      this.lastSpokenKey = msg.key;
      this.lastSpokenPriority = 0;
      this.currentUtterancePriority = 0;
      this.emitDecision({ type: "spoken", reason: "P0_immediate" }, msg);
      return true;
    }

    if (now - msg.timestamp > msg.ttlMs) {
      this.emitDecision({ type: "dropped", reason: "ttl_expired" }, msg);
      return false; // expired before enqueue
    }

    // Dedupe for P1 (hazards and status): same key within dedupe window (4s)
    if (msg.priority === 1 && !msg.isRecovery) {
      const keyLastSpoken = this.lastSpokenAtByP1Key.get(msg.key);
      if (keyLastSpoken !== undefined && now - keyLastSpoken < this.config.hazardDedupeMs) {
        this.emitDecision({ type: "dropped", reason: "dedupe" }, msg);
        return false; // duplicate within 4s
      }
    }

    // Insert by priority (highest first), then by priority-specific ordering:
    // P1: hazards by urgency desc (urgency >= 2 first), then recovery status, then hazards urgency < 2, then timestamp FIFO
    // Other priorities: timestamp FIFO
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      const existing = this.queue[i]!;
      let shouldInsertBefore = false;

      if (msg.priority < existing.priority) {
        shouldInsertBefore = true;
      } else if (msg.priority === existing.priority) {
        if (msg.priority === 1) {
          // P1: order by urgency desc for hazards (urgency >= 2 first), then recovery, then lower urgency hazards
          const msgIsRecovery = msg.isRecovery === true;
          const existingIsRecovery = existing.isRecovery === true;
          const msgIsHazard = !msgIsRecovery && !msg.isStatus;
          const existingIsHazard = !existingIsRecovery && !existing.isStatus;
          const msgUrgency = msg.urgency ?? 0;
          const existingUrgency = existing.urgency ?? 0;

          if (msgIsHazard && existingIsHazard) {
            // Both hazards: higher urgency first, then earlier timestamp
            if (msgUrgency > existingUrgency || (msgUrgency === existingUrgency && msg.timestamp < existing.timestamp)) {
              shouldInsertBefore = true;
            }
          } else if (msgIsHazard && existingIsRecovery) {
            // Hazard before recovery
            shouldInsertBefore = true;
          } else if (msgIsRecovery && existingIsHazard) {
            // Recovery after hazard
            shouldInsertBefore = false;
          } else if (msgIsRecovery && existingIsRecovery) {
            // Both recovery: FIFO
            if (msg.timestamp < existing.timestamp) {
              shouldInsertBefore = true;
            }
          } else if (msg.isStatus && existingIsHazard) {
            // Other status after hazard
            shouldInsertBefore = false;
          } else if (msgIsHazard && existing.isStatus) {
            // Hazard before other status
            shouldInsertBefore = true;
          } else if (msg.isStatus && existing.isStatus) {
            // Both status (non-recovery): FIFO
            if (msg.timestamp < existing.timestamp) {
              shouldInsertBefore = true;
            }
          }
        } else {
          // Other priorities: FIFO
          if (msg.timestamp < existing.timestamp) {
            shouldInsertBefore = true;
          }
        }
      }

      if (shouldInsertBefore) {
        this.queue.splice(i, 0, msg);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.queue.push(msg);
    }

    this.processQueue();
    return true;
  }

  /** Called when TTS finishes or is interrupted. */
  onSpeechEnd(): void {
    // Check if a status message has been waiting > 3s while a P1 hazard was speaking
    // This implements "status messages not held by hazards > 3s" (AGENTS.md)
    if (this.currentUtterancePriority === 1 && !this.isCurrentStatusMessage()) {
      const statusMsg = this.queue.find((m) => m.priority === 1 && m.isStatus);
      if (statusMsg && !statusMsg.isRecovery && Date.now() - statusMsg.timestamp > this.config.statusMaxWaitMs) {
        this.cancelFn(this.currentUtterancePriority as Priority); // Interrupt the hazard for the status message
        this.emitDecision({ type: "interrupt", reason: "status_interrupts_P1" }, statusMsg);
      }
    }
    this.isSpeaking = false;
    this.processQueue();
  }


  getLastSpokenAt(): number {
    return this.lastSpokenAt;
  }

  getLastHazardSpokenAt(): number {
    return this.lastHazardSpokenAt;
  }

  /** Called when TTS starts. */
  onSpeechStart(priority: Priority): void {
    this.isSpeaking = true;
    this.currentUtterancePriority = priority;
  }

  /** Clear queue (e.g., on stop vision). */
  clear(): void {
    this.queue = [];
    this.cancelFn(this.currentUtterancePriority as Priority);
    this.isSpeaking = false;
  }

  /** Process the queue (public for testing). */
  processQueueForTest(): void {
    this.processQueue();
  }

  private processQueue(): void {
    if (this.isSpeaking) {
      // If currently speaking P0, only P0 can interrupt
      if (this.currentUtterancePriority === 0) {
        this.emitDecision({ type: "deferred", reason: "P0_active" });
        return; // P0 speaking — only P0 interrupts
      }

      // If currently speaking P1 status, only P0 or status (after 3s wait) can interrupt
      // Recovery does NOT interrupt status messages
      if (this.currentUtterancePriority === 1 && this.isCurrentStatusMessage()) {
        this.emitDecision({ type: "deferred", reason: "P1_active" });
        return; // P1 status speaking — only P0 or status (after wait) interrupts
      }

      // If currently speaking P1 hazard
      if (this.currentUtterancePriority === 1) {
        // Check for P1 hazards in queue that could interrupt (not recovery, not status)
        const queuedP1Hazards = this.queue.filter((m) => m.priority === 1 && !m.isStatus && !m.isRecovery);
        if (queuedP1Hazards.length > 0) {
          // Find the most urgent/highest priority P1 to potentially interrupt
          // Sort by urgency (desc), then by timestamp (asc)
          queuedP1Hazards.sort((a, b) => {
            const urgencyA = a.urgency ?? 0;
            const urgencyB = b.urgency ?? 0;
            if (urgencyB !== urgencyA) return urgencyB - urgencyA;
            return a.timestamp - b.timestamp;
          });

          const bestP1 = queuedP1Hazards[0]!;
          const currentKey = this.lastSpokenKey;
          const bestUrgency = bestP1.urgency ?? 0;

          // Urgency 3 always interrupts a speaking P1
          if (bestUrgency >= 3) {
            this.cancelFn(bestP1.priority);
            this.emitDecision({
              type: "interrupt",
              reason: "P1_urgency3_interrupts_P1"
            }, bestP1);
            return;
          }

          // Different key or higher urgency (but not 3): queue as "next" (at most 1 queued P1)
          if (bestP1.key !== currentKey || bestUrgency > (this.lastSpokenUrgency ?? 0)) {
            // Limit queue to at most 1 non-status P1 waiting
            // Remove any existing queued non-status P1 (keep the best one)
            const otherP1InQueue = this.queue.filter(
              (m) => m.priority === 1 && !m.isStatus && !m.isRecovery && m !== bestP1
            );
            for (const m of otherP1InQueue) {
              const idx = this.queue.indexOf(m);
              if (idx >= 0) this.queue.splice(idx, 1);
              this.emitDecision({ type: "dropped", reason: "queue_limit" }, m);
            }

            // Don't interrupt immediately, let current finish then speak the queued one
            // The queued P1 will be spoken in next processQueue after onSpeechEnd
            this.emitDecision({ type: "deferred", reason: "P1_queued_as_next" }, bestP1);
            return;
          }
          // Same key and lower/equal urgency (not 3): already dropped by dedupe in enqueue, or wait
          // Don't interrupt, let current finish
        }
        // Also check for P0
        const p0Msg = this.queue.find((m) => m.priority === 0);
        if (p0Msg) {
          this.cancelFn(p0Msg.priority);
          this.emitDecision({ type: "interrupt", reason: "P0" }, p0Msg);
        }
        return;
      }

      // P2 or P3 speaking — any P1 hazard (not recovery, not status) interrupts immediately
      const queuedP1Hazards = this.queue.filter((m) => m.priority === 1 && !m.isStatus && !m.isRecovery);
      if (queuedP1Hazards.length > 0) {
        // Find the best P1 to interrupt with (highest urgency, then latest timestamp)
        queuedP1Hazards.sort((a, b) => {
          const urgencyA = a.urgency ?? 0;
          const urgencyB = b.urgency ?? 0;
          if (urgencyB !== urgencyA) return urgencyB - urgencyA;
          return b.timestamp - a.timestamp; // latest first for same urgency
        });

        const bestP1 = queuedP1Hazards[0]!;

        // Limit queue to at most 1 non-status P1 waiting
        // Remove any other non-status P1s (keep the best one)
        const otherP1InQueue = queuedP1Hazards.slice(1);
        for (const m of otherP1InQueue) {
          const idx = this.queue.indexOf(m);
          if (idx >= 0) this.queue.splice(idx, 1);
          this.emitDecision({ type: "dropped", reason: "queue_limit" }, m);
        }

        this.cancelFn(bestP1.priority);
        this.emitDecision({
          type: "interrupt",
          reason: this.currentUtterancePriority === 2 ? "P1_interrupts_P2" : "P1_interrupts_P3"
        }, bestP1);
        return;
      }
      return;
    }

    const now = Date.now();

    // Remove expired messages
    this.queue = this.queue.filter((m) => now - m.timestamp <= m.ttlMs);

    // Check for recovery messages that have waited > 6s - drop them
    const recoveryMsgs = this.queue.filter((m) => m.priority === 1 && m.isRecovery);
    for (const recoveryMsg of recoveryMsgs) {
      if (now - recoveryMsg.timestamp > 6000) {
        const idx = this.queue.indexOf(recoveryMsg);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.emitDecision({ type: "dropped", reason: "recovery_timeout" }, recoveryMsg);
      }
    }

    if (this.queue.length === 0) return;

    const next = this.queue[0]!;

    // P1 hazard: enforce min interval ONLY for same key (not for different keys)
    // Use per-key tracking so rate limit applies regardless of what was spoken in between
    if (next.priority === 1 && !next.isStatus && !next.isRecovery) {
      const keyLastSpoken = this.lastSpokenAtByP1Key.get(next.key);
      if (keyLastSpoken !== undefined && now - keyLastSpoken < this.config.hazardMinIntervalMs) {
        this.emitDecision({ type: "deferred", reason: "rate_limit" }, next);
        return; // wait for rate limit (same key)
      }
      // Different key or first time: no rate limit, speak immediately
    }

    // Recovery status: speak only if no hazards (urgency >= 2) are waiting
    // Check if there are any hazards in the queue (not recovery, not status)
    const hasHazardsWaiting = this.queue.some((m) => m.priority === 1 && !m.isStatus && !m.isRecovery);
    if (next.priority === 1 && next.isRecovery) {
      if (hasHazardsWaiting) {
        // Wait for hazards to finish first
        this.emitDecision({ type: "deferred", reason: "recovery_waiting_for_hazard" }, next);
        return;
      }
      // No hazards waiting - speak recovery immediately (plain TTS, no manifest lookup)
      this.queue.shift();
      this.isSpeaking = true;
      this.currentUtterancePriority = next.priority;
      this.speakFn(next.text, next.language, next.key, next.responseReceivedPerfMs, undefined, undefined);
      this.lastSpokenAt = now;
      this.lastSpokenKey = next.key;
      this.lastSpokenPriority = next.priority;
      // Use "recovery_after_hazard" if last spoken was a hazard (urgency > 0), else "recovery_immediate"
      const recoveryReason = this.lastSpokenUrgency > 0 ? "recovery_after_hazard" : "recovery_immediate";
      this.emitDecision({ type: "spoken", reason: recoveryReason }, next);
      return;
    }

    // Speak it
    this.queue.shift();
    this.isSpeaking = true;
    this.currentUtterancePriority = next.priority;
    this.speakFn(next.text, next.language, next.key, next.responseReceivedPerfMs, next.clipKey, next.clipType);
    this.lastSpokenAt = now;
    this.lastSpokenKey = next.key;
    this.lastSpokenPriority = next.priority;
    if (next.priority === 1) {
      this.lastSpokenAtByP1Key.set(next.key, now);
      if (!next.isStatus && !next.isRecovery) {
        this.lastHazardSpokenAt = now;
        this.lastSpokenUrgency = next.urgency ?? 0;
      }
    }
    const spokenReason = this.lastSpokenPriority === 0 ? "P0_immediate" :
                         (next.isRecovery ? "recovery_after_hazard" : "normal");
    this.emitDecision({ type: "spoken", reason: spokenReason }, next);
  }

  private isCurrentStatusMessage(): boolean {
    return this.lastSpokenKey.startsWith("status:");
  }
}

import { getHazardClipKey, getSystemClipKey } from "./audio";

/** Factory for creating hazard messages with correct priority/TTL/key. */
export function makeHazardMessage(
  hazardType: string,
  direction: string,
  text: string,
  language: "en" | "hi",
  urgency: number,
  _confidence: number,
  responseReceivedPerfMs?: number,
  clearSide?: string,
  customKey?: string
): ArbiterMessage {
  const priority: Priority = 1; // all hazards are P1
  const key = customKey ?? `hazard:${hazardType}:${direction}`;
  const ttlMs = 2000; // hazard TTL 2s
  // Low confidence: hedge wording is handled by phrase builder
  const clipKey = getHazardClipKey(hazardType, direction, clearSide || "none");
  return { priority, text, ttlMs, key, language, timestamp: Date.now(), responseReceivedPerfMs, clipKey, clipType: "hazards", urgency };
}

/** Factory for navigation messages (P2). */
export function makeNavMessage(
  text: string,
  language: "en" | "hi",
  key: string
): ArbiterMessage {
  return {
    priority: 2,
    text,
    ttlMs: 10000,
    key: `nav:${key}`,
    language,
    timestamp: Date.now(),
  };
}

/** Factory for advisory/chat messages (P3). */
export function makeAdvisoryMessage(
  text: string,
  language: "en" | "hi",
  key: string
): ArbiterMessage {
  return {
    priority: 3,
    text,
    ttlMs: 15000,
    key: `adv:${key}`,
    language,
    timestamp: Date.now(),
  };
}

/** Factory for emergency messages (P0). */
export function makeEmergencyMessage(
  text: string,
  language: "en" | "hi"
): ArbiterMessage {
  return {
    priority: 0,
    text,
    ttlMs: 0, // no TTL for emergency
    key: "emergency",
    language,
    timestamp: Date.now(),
  };
}

/** Factory for Vision paused status (P1 with status flag). */
export function makeVisionPausedMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.vision_paused;
  return {
    priority: 1,
    text: language === "hi" ? (msg?.hi ?? "दृष्टि रुकी") : (msg?.en ?? "Vision paused"),
    ttlMs: 5000, // longer TTL for status
    key: "status:vision_paused",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("vision_paused"),
    clipType: "system",
  };
}

/** Factory for Vision back status (P1 with status flag). */
export function makeVisionBackMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.vision_back;
  return {
    priority: 1,
    text: language === "hi" ? (msg?.hi ?? "दृष्टि वापस") : (msg?.en ?? "Vision back"),
    ttlMs: 5000,
    key: "status:vision_back",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("vision_back"),
    clipType: "system",
  };
}

/** Factory for Vision limited status (P1 with status flag). */
export function makeVisionLimitedMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.vision_limited;
  return {
    priority: 1,
    text: language === "hi" ? (msg?.hi ?? "दृष्टि सीमित") : (msg?.en ?? "Vision limited"),
    ttlMs: 20000, // longer TTL, repeats every 15s handled by client
    key: "status:vision_limited",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("vision_limited"),
    clipType: "system",
  };
}

/** Factory for Vision limited moving-only status (Req D9, P1 with status flag). */
export function makeVisionLimitedMovingOnlyMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.vision_limited_moving_only;
  return {
    priority: 1,
    text: language === "hi"
      ? (msg?.hi ?? "दृष्टि सीमित, केवल गतिमान वस्तुएँ")
      : (msg?.en ?? "Vision limited, moving-object alerts only"),
    ttlMs: 20000,
    key: "status:vision_limited_moving_only",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("vision_limited_moving_only"),
    clipType: "system",
  };
}

/** Factory for Detector unavailable status (P1 with status flag). */
export function makeDetectorUnavailableMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.detector_unavailable;
  return {
    priority: 1,
    text: language === "hi" ? (msg?.hi ?? "डिटेक्टर अनुपलब्ध") : (msg?.en ?? "Detector unavailable"),
    ttlMs: 10000,
    key: "status:detector_unavailable",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("detector_unavailable"),
    clipType: "system",
  };
}

/** Factory for Camera blocked status (P1 with status flag). */
export function makeCameraBlockedMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.camera_blocked;
  return {
    priority: 1,
    text: language === "hi" ? (msg?.hi ?? "कैमरा बंद या बहुत पास, रुकें") : (msg?.en ?? "Camera blocked or too close, stop"),
    ttlMs: 5000,
    key: "status:camera_blocked",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("camera_blocked"),
    clipType: "system",
  };
}

/** Factory for Camera clear status (P1 with status flag). */
export function makeCameraClearMessage(language: "en" | "hi"): ArbiterMessage {
  const msg = SYSTEM_MESSAGES.camera_clear;
  return {
    priority: 1,
    text: language === "hi" ? (msg?.hi ?? "कैमरा साफ़") : (msg?.en ?? "Camera clear"),
    ttlMs: 5000,
    key: "status:camera_clear",
    language,
    timestamp: Date.now(),
    isStatus: true,
    clipKey: getSystemClipKey("camera_clear"),
    clipType: "system",
  };
}

