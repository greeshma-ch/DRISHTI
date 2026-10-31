/** Priority Arbiter tests — pure logic, no DOM. */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PriorityArbiter,
  makeHazardMessage,
  makeNavMessage,
  makeAdvisoryMessage,
  makeEmergencyMessage,
  makeVisionPausedMessage,
  makeVisionBackMessage,
  makeVisionLimitedMessage,
} from "./arbiter";

describe("PriorityArbiter", () => {
  let speakFn: ReturnType<typeof vi.fn>;
  let cancelFn: ReturnType<typeof vi.fn>;
  let arbiter: PriorityArbiter;

  beforeEach(() => {
    speakFn = vi.fn();
    cancelFn = vi.fn();
    arbiter = new PriorityArbiter(speakFn, cancelFn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic enqueue and speak", () => {
    it("speaks P0 emergency immediately, bypassing queue", () => {
      const msg = makeEmergencyMessage("Emergency!", "en");
      arbiter.enqueue(msg);
      expect(speakFn).toHaveBeenCalledWith("Emergency!", "en", "emergency", undefined, undefined, undefined);
      expect(cancelFn).toHaveBeenCalled();
    });

    it("queues P1 hazard and speaks when processed", () => {
      const msg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg);
      // Process queue - should speak immediately since nothing is speaking
      expect(speakFn).toHaveBeenCalledWith("Pole left, step right", "en", "hazard:pole:left", undefined, "pole:left:none", "hazards");
    });

    it("queues P2 nav and speaks when idle", () => {
      const msg = makeNavMessage("Turn left in 30 steps", "en", "turn1");
      arbiter.enqueue(msg);
      expect(speakFn).toHaveBeenCalledWith("Turn left in 30 steps", "en", "nav:turn1", undefined, undefined, undefined);
    });

    it("queues P3 advisory and speaks when idle", () => {
      const msg = makeAdvisoryMessage("Weather is clear", "en", "weather1");
      arbiter.enqueue(msg);
      expect(speakFn).toHaveBeenCalledWith("Weather is clear", "en", "adv:weather1", undefined, undefined, undefined);
    });
  });

  describe("priority interrupts", () => {
    it("P1 interrupts P2 mid-sentence", () => {
      // Start speaking P2
      const p2Msg = makeNavMessage("Turn left in 30 steps", "en", "turn1");
      arbiter.enqueue(p2Msg);
      arbiter.onSpeechStart(2);

      // Enqueue P1 while P2 is speaking
      const p1Msg = makeHazardMessage("vehicle", "center", "Vehicle ahead, step left", "en", 2, 0.9);
      arbiter.enqueue(p1Msg);

      // Should cancel P2
      expect(cancelFn).toHaveBeenCalled();
    });

    it("P1 interrupts P3 mid-sentence", () => {
      const p3Msg = makeAdvisoryMessage("Weather is clear", "en", "weather1");
      arbiter.enqueue(p3Msg);
      arbiter.onSpeechStart(3);

      const p1Msg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(p1Msg);

      expect(cancelFn).toHaveBeenCalled();
    });

    it("P0 interrupts everything including P1", () => {
      const p1Msg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(p1Msg);
      arbiter.onSpeechStart(1);

      const p0Msg = makeEmergencyMessage("Emergency!", "en");
      arbiter.enqueue(p0Msg);

      expect(cancelFn).toHaveBeenCalled();
      expect(speakFn).toHaveBeenCalledWith("Emergency!", "en", "emergency", undefined, undefined, undefined);
    });

    it("P1 does not interrupt another P1", () => {
      const p1Msg1 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(p1Msg1);
      arbiter.onSpeechStart(1);

      const p1Msg2 = makeHazardMessage("vehicle", "center", "Vehicle ahead", "en", 2, 0.9);
      arbiter.enqueue(p1Msg2);

      // Should not cancel - P1 doesn't interrupt P1
      expect(cancelFn).not.toHaveBeenCalled();
    });
  });

  describe("dedupe and rate limit", () => {
    it("dedupes same hazard key within 4s", () => {
      const msg1 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg1);
      expect(speakFn).toHaveBeenCalledTimes(1);

      // Same key within 4s - should be dropped
      const msg2 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg2);
      expect(speakFn).toHaveBeenCalledTimes(1); // Still 1
    });

    it("allows same hazard key after 4s", () => {
      const msg1 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg1);
      expect(speakFn).toHaveBeenCalledTimes(1);

      // Manually set all tracking fields to 5 seconds ago to simulate time passing
      const fiveSecondsAgo = Date.now() - 5000;
      (arbiter as any).lastSpokenAtByP1Key.set("hazard:pole:left", fiveSecondsAgo);
      (arbiter as any).lastSpokenAt = fiveSecondsAgo;
      (arbiter as any).lastSpokenPriority = 1;
      (arbiter as any).lastHazardSpokenAt = fiveSecondsAgo;

      // New message with same key but current timestamp
      const msg2 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg2);
      expect(speakFn).toHaveBeenCalledTimes(2);
    });

    it("rate limits same-key hazards to 1.5s minimum interval", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const msg1 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg1);
      expect(speakFn).toHaveBeenCalledTimes(1);

      // Simulate speech start and end
      arbiter.onSpeechStart(1);
      arbiter.onSpeechEnd();
      speakFn.mockClear();

      // Advance time by 1 second (within 1.5s rate limit window)
      vi.advanceTimersByTime(1000);

      // Same hazard key within 1.5s - should be rate limited (same key)
      const msg2 = makeHazardMessage("pole", "left", "Pole left again", "en", 2, 0.9);
      arbiter.enqueue(msg2);
      expect(speakFn).toHaveBeenCalledTimes(0); // Dropped by rate limit

      vi.useRealTimers();
    });

    it("allows hazard after 1.5s interval", () => {
      const msg1 = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg1);
      expect(speakFn).toHaveBeenCalledTimes(1);

      // Manually set lastHazardSpokenAt to 2 seconds ago
      // Also update lastSpokenAt and lastSpokenPriority so processQueue rate limit check passes
      (arbiter as any).lastHazardSpokenAt = Date.now() - 2000;
      (arbiter as any).lastSpokenAt = Date.now() - 2000;
      (arbiter as any).lastSpokenPriority = 1;

      const msg2 = makeHazardMessage("vehicle", "center", "Vehicle ahead", "en", 2, 0.9);
      arbiter.enqueue(msg2);
      expect(speakFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("TTL expiration", () => {
    it("drops expired messages before enqueue", () => {
      const msg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      // Set timestamp to 3 seconds ago (TTL is 2s)
      (msg as any).timestamp = Date.now() - 3000;
      const result = arbiter.enqueue(msg);
      expect(result).toBe(false);
      expect(speakFn).not.toHaveBeenCalled();
    });

    it("drops expired messages during processQueue", () => {
      const msg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      arbiter.enqueue(msg);
      expect(speakFn).toHaveBeenCalledTimes(1);

      // Manually advance time and process queue - message should be expired
      vi.useFakeTimers();
      vi.advanceTimersByTime(3000);

      arbiter.onSpeechEnd(); // This triggers processQueue
      expect(speakFn).toHaveBeenCalledTimes(1); // No additional speak

      vi.useRealTimers();
    });

    it("hazard TTL counts from arbiter receipt (not frame capture)", () => {
      // Simulate: frame captured at T=0, Tier 2 returns at T=3s, message enqueued at T=3s
      // TTL should be 2s from T=3s (arbiter receipt), so expires at T=5s
      const msg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
      // The message timestamp is set to now (arbiter receipt time)
      // This test verifies the TTL logic uses the message timestamp, not capture time

      // Message enqueued now (T=3s from capture perspective)
      const enqueueResult = arbiter.enqueue(msg);
      expect(enqueueResult).toBe(true);
      expect(speakFn).toHaveBeenCalledTimes(1);

      // At T=4s from capture (1s after enqueue), should still be valid
      vi.useFakeTimers();
      vi.advanceTimersByTime(1000); // Now T=4s from capture, 1s after enqueue
      arbiter.onSpeechEnd();
      expect(speakFn).toHaveBeenCalledTimes(1);

      // At T=6s from capture (3s after enqueue), should be expired (TTL=2s)
      vi.advanceTimersByTime(2000); // Now T=6s from capture, 3s after enqueue
      arbiter.onSpeechEnd();
      expect(speakFn).toHaveBeenCalledTimes(1); // No additional speak

      vi.useRealTimers();
    });
  });

  describe("queue processing order", () => {
    it("processes higher priority first", () => {
      const p3 = makeAdvisoryMessage("Advisory", "en", "adv1");
      const p2 = makeNavMessage("Navigation", "en", "nav1");
      const p1 = makeHazardMessage("pole", "left", "Hazard", "en", 2, 0.9);

      arbiter.enqueue(p3);
      arbiter.enqueue(p2);
      arbiter.enqueue(p1);

      // P1 should speak first
      expect(speakFn).toHaveBeenCalledWith("Hazard", "en", "hazard:pole:left", undefined, "pole:left:none", "hazards");
    });

    it("FIFO for same priority", () => {
      const p2a = makeNavMessage("First nav", "en", "nav1");
      const p2b = makeNavMessage("Second nav", "en", "nav2");

      arbiter.enqueue(p2a);
      arbiter.enqueue(p2b);

      expect(speakFn).toHaveBeenCalledWith("First nav", "en", "nav:nav1", undefined, undefined, undefined);
    });
  });

  describe("clear", () => {
    it("clears queue and cancels speech", () => {
      const msg = makeAdvisoryMessage("Advisory", "en", "adv1");
      arbiter.enqueue(msg);
      arbiter.onSpeechStart(3);

      arbiter.clear();

      expect(cancelFn).toHaveBeenCalled();
      expect((arbiter as any).queue).toEqual([]);
      expect((arbiter as any).isSpeaking).toBe(false);
    });
  });
});

describe("Message factories", () => {
  it("makeHazardMessage creates P1 with correct key and TTL", () => {
    const msg = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    expect(msg.priority).toBe(1);
    expect(msg.key).toBe("hazard:pole:left");
    expect(msg.ttlMs).toBe(2000);
    expect(msg.language).toBe("en");
    expect(msg.text).toBe("Pole left");
  });

  it("makeNavMessage creates P2 with correct key and TTL", () => {
    const msg = makeNavMessage("Turn left", "en", "turn1");
    expect(msg.priority).toBe(2);
    expect(msg.key).toBe("nav:turn1");
    expect(msg.ttlMs).toBe(10000);
  });

  it("makeAdvisoryMessage creates P3 with correct key and TTL", () => {
    const msg = makeAdvisoryMessage("Weather clear", "en", "weather1");
    expect(msg.priority).toBe(3);
    expect(msg.key).toBe("adv:weather1");
    expect(msg.ttlMs).toBe(15000);
  });

  it("makeEmergencyMessage creates P0 with no TTL", () => {
    const msg = makeEmergencyMessage("Emergency", "en");
    expect(msg.priority).toBe(0);
    expect(msg.key).toBe("emergency");
    expect(msg.ttlMs).toBe(0);
  });

  it("makeVisionPausedMessage creates P1 status with correct key", () => {
    const msg = makeVisionPausedMessage("en");
    expect(msg.priority).toBe(1);
    expect(msg.key).toBe("status:vision_paused");
    expect(msg.ttlMs).toBe(5000);
    expect(msg.isStatus).toBe(true);
    expect(msg.text).toBe("Vision paused");
  });

  it("makeVisionBackMessage creates P1 status with correct key", () => {
    const msg = makeVisionBackMessage("en");
    expect(msg.priority).toBe(1);
    expect(msg.key).toBe("status:vision_back");
    expect(msg.isStatus).toBe(true);
    expect(msg.text).toBe("Vision back");
  });

  it("makeVisionLimitedMessage creates P1 status with correct key", () => {
    const msg = makeVisionLimitedMessage("en");
    expect(msg.priority).toBe(1);
    expect(msg.key).toBe("status:vision_limited");
    expect(msg.isStatus).toBe(true);
    expect(msg.text).toBe("Vision limited");
  });

  it("status messages have Hindi variants", () => {
    expect(makeVisionPausedMessage("hi").text).toBe("दृष्टि रुकी");
    expect(makeVisionBackMessage("hi").text).toBe("दृष्टि वापस");
    expect(makeVisionLimitedMessage("hi").text).toBe("दृष्टि सीमित");
  });
});

describe("Status message interrupt", () => {
  let speakFn: ReturnType<typeof vi.fn>;
  let cancelFn: ReturnType<typeof vi.fn>;
  let arbiter: PriorityArbiter;

  beforeEach(() => {
    speakFn = vi.fn();
    cancelFn = vi.fn();
    arbiter = new PriorityArbiter(speakFn, cancelFn);
  });

  it("status message interrupts P1 hazard after 3s max wait", () => {
    // Start speaking a P1 hazard
    const hazardMsg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
    arbiter.enqueue(hazardMsg);
    arbiter.onSpeechStart(1);
    expect(speakFn).toHaveBeenCalledWith("Pole left, step right", "en", "hazard:pole:left", undefined, "pole:left:none", "hazards");
    speakFn.mockClear();

    // Enqueue a status message with timestamp 4 seconds ago (simulating it waited 4s)
    const statusMsg = makeVisionPausedMessage("en");
    (statusMsg as any).timestamp = Date.now() - 4000;
    arbiter.enqueue(statusMsg);

    // Should not interrupt immediately (P1 doesn't interrupt P1 normally)
    expect(cancelFn).not.toHaveBeenCalled();

    // Process queue should now interrupt because status message waited > 3s
    arbiter.onSpeechEnd();
    expect(cancelFn).toHaveBeenCalled();
  });

  it("status message does not interrupt P1 hazard before 3s", () => {
    const hazardMsg = makeHazardMessage("pole", "left", "Pole left, step right", "en", 2, 0.9);
    arbiter.enqueue(hazardMsg);
    arbiter.onSpeechStart(1);
    speakFn.mockClear();

    const statusMsg = makeVisionPausedMessage("en");
    arbiter.enqueue(statusMsg);

    // Advance time by 2 seconds (less than 3s)
    vi.useFakeTimers();
    vi.advanceTimersByTime(2000);

    arbiter.onSpeechEnd();
    expect(cancelFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("status message interrupts P2 immediately", () => {
    const navMsg = makeNavMessage("Turn left", "en", "turn1");
    arbiter.enqueue(navMsg);
    arbiter.onSpeechStart(2);

    const statusMsg = makeVisionPausedMessage("en");
    arbiter.enqueue(statusMsg);

    // Should interrupt P2 immediately (normal P1 behavior)
    expect(cancelFn).toHaveBeenCalled();
  });

  it("status message dedupes with same key", () => {
    const msg1 = makeVisionPausedMessage("en");
    arbiter.enqueue(msg1);
    expect(speakFn).toHaveBeenCalledTimes(1);

    // Same status key within 4s - should be dropped
    const msg2 = makeVisionPausedMessage("en");
    arbiter.enqueue(msg2);
    expect(speakFn).toHaveBeenCalledTimes(1);
  });
});

describe("Refined P1 rate-limit policy", () => {
  let speakFn: ReturnType<typeof vi.fn>;
  let cancelFn: ReturnType<typeof vi.fn>;
  let arbiter: PriorityArbiter;

  beforeEach(() => {
    speakFn = vi.fn();
    cancelFn = vi.fn();
    arbiter = new PriorityArbiter(speakFn, cancelFn);
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pole-left after vehicle-right within 1s is spoken (different key, no rate limit)", () => {
    // First hazard: vehicle-right (urgency 2)
    const msg1 = makeHazardMessage("vehicle", "right", "Vehicle right", "en", 2, 0.9);
    arbiter.enqueue(msg1);
    expect(speakFn).toHaveBeenCalledTimes(1);
    const firstCall = speakFn.mock.calls[0];
    expect(firstCall[0]).toBe("Vehicle right");

    // Simulate speech start
    arbiter.onSpeechStart(1);
    speakFn.mockClear();

    // Advance time by 1 second (within 1.5s rate limit window)
    vi.advanceTimersByTime(1000);

    // Second hazard: pole-left (different key, urgency 2)
    const msg2 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    arbiter.enqueue(msg2);

    // Should NOT be dropped - different key means no rate limit
    // Since P1 is speaking, it should queue as "next" (deferred), NOT interrupt immediately
    // cancelFn should NOT be called for queued-as-next
    expect(cancelFn).not.toHaveBeenCalled();

    // The message should be in queue as "next"
    const queue = (arbiter as any).queue;
    const p1InQueue = queue.filter((m: any) => m.priority === 1 && !m.isStatus);
    expect(p1InQueue.length).toBe(1);
    expect(p1InQueue[0].key).toBe("hazard:pole:left");
  });

  it("same-key repeat within 1.5s is dropped (rate limit)", () => {
    // First hazard: pole-left
    const msg1 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    arbiter.enqueue(msg1);
    expect(speakFn).toHaveBeenCalledTimes(1);

    // Simulate speech start and end
    arbiter.onSpeechStart(1);
    arbiter.onSpeechEnd();
    speakFn.mockClear();

    // Advance time by 1 second (within 1.5s rate limit window)
    vi.advanceTimersByTime(1000);

    // Second hazard: same key (pole-left)
    const msg2 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    const result = arbiter.enqueue(msg2);

    // Should be dropped due to rate limit (same key within 1.5s)
    expect(result).toBe(false);
    expect(speakFn).toHaveBeenCalledTimes(0);
  });

  it("urgency 3 interrupts a speaking P1", () => {
    // First hazard: pole-left (urgency 2)
    const msg1 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    arbiter.enqueue(msg1);
    expect(speakFn).toHaveBeenCalledTimes(1);

    // Simulate speech start
    arbiter.onSpeechStart(1);
    speakFn.mockClear();

    // Advance time by 500ms
    vi.advanceTimersByTime(500);

    // Second hazard: vehicle-center with urgency 3 (highest)
    const msg2 = makeHazardMessage("vehicle", "center", "Vehicle center urgent", "en", 3, 0.95);
    arbiter.enqueue(msg2);

    // Should interrupt immediately because urgency 3
    expect(cancelFn).toHaveBeenCalled();
  });

  it("at most one queued P1 (queue length 1, TTL 2s from arrival)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Start with a P3 message speaking
    const p3Msg = makeAdvisoryMessage("Advisory message", "en", "adv1");
    arbiter.enqueue(p3Msg);
    arbiter.onSpeechStart(3);
    speakFn.mockClear();

    // Queue first P1 (vehicle-right)
    const p1Msg1 = makeHazardMessage("vehicle", "right", "Vehicle right", "en", 2, 0.9);
    arbiter.enqueue(p1Msg1);

    // Should interrupt P3
    expect(cancelFn).toHaveBeenCalled();
    cancelFn.mockClear();

    // Advance time by 100ms
    vi.advanceTimersByTime(100);

    // Queue second P1 (pole-left) - different key, should also queue as "next"
    const p1Msg2 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    arbiter.enqueue(p1Msg2);

    // Advance time by 100ms
    vi.advanceTimersByTime(100);

    // Queue third P1 (person-center) - different key, should replace the queued one (at most 1 queued)
    const p1Msg3 = makeHazardMessage("person", "center", "Person center", "en", 2, 0.9);
    arbiter.enqueue(p1Msg3);

    // Check queue has at most 1 P1 waiting (the latest one)
    const queue = (arbiter as any).queue;
    const p1InQueue = queue.filter((m: any) => m.priority === 1 && !m.isStatus);
    expect(p1InQueue.length).toBeLessThanOrEqual(1);

    // If there's one in queue, it should be the latest (p1Msg3)
    if (p1InQueue.length === 1) {
      expect(p1InQueue[0].key).toBe("hazard:person:center");
    }

    vi.useRealTimers();
  });

  it("higher urgency P1 replaces lower urgency queued P1", () => {
    // Start with a P3 message speaking
    const p3Msg = makeAdvisoryMessage("Advisory message", "en", "adv1");
    arbiter.enqueue(p3Msg);
    arbiter.onSpeechStart(3);
    speakFn.mockClear();

    // Queue first P1 (urgency 1)
    const p1Msg1 = makeHazardMessage("pole", "left", "Pole left low urgency", "en", 1, 0.7);
    arbiter.enqueue(p1Msg1);
    expect(cancelFn).toHaveBeenCalled();
    cancelFn.mockClear();

    // Queue second P1 with higher urgency (urgency 3) - different key
    const p1Msg2 = makeHazardMessage("vehicle", "center", "Vehicle center high urgency", "en", 3, 0.95);
    arbiter.enqueue(p1Msg2);

    // The queued P1 should be the higher urgency one
    const queue = (arbiter as any).queue;
    const p1InQueue = queue.filter((m: any) => m.priority === 1 && !m.isStatus);
    expect(p1InQueue.length).toBe(1);
    expect(p1InQueue[0].urgency).toBe(3);
    expect(p1InQueue[0].key).toBe("hazard:vehicle:center");
  });

  it("same key within 4s dedupe window is dropped at enqueue", () => {
    // First hazard
    const msg1 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    arbiter.enqueue(msg1);
    expect(speakFn).toHaveBeenCalledTimes(1);

    // Simulate speech start and end
    arbiter.onSpeechStart(1);
    arbiter.onSpeechEnd();
    speakFn.mockClear();

    // Advance time by 2 seconds (within 4s dedupe window)
    vi.advanceTimersByTime(2000);

    // Same key again - should be dropped by dedupe at enqueue
    const msg2 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    const result = arbiter.enqueue(msg2);

    expect(result).toBe(false);
    expect(speakFn).toHaveBeenCalledTimes(0);
  });

  it("same key after 4s dedupe window is allowed", () => {
    // First hazard
    const msg1 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    arbiter.enqueue(msg1);
    expect(speakFn).toHaveBeenCalledTimes(1);

    // Simulate speech start and end
    arbiter.onSpeechStart(1);
    arbiter.onSpeechEnd();
    speakFn.mockClear();

    // Advance time by 5 seconds (past 4s dedupe window)
    vi.advanceTimersByTime(5000);

    // Same key again - should be allowed now
    const msg2 = makeHazardMessage("pole", "left", "Pole left", "en", 2, 0.9);
    const result = arbiter.enqueue(msg2);

    expect(result).toBe(true);
    expect(speakFn).toHaveBeenCalledTimes(1);
  });
});