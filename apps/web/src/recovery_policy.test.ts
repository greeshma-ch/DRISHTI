/** Recovery Policy Tests - verify new recovery behavior per policy. */
import { describe, it, expect, beforeEach } from "vitest";
import { PriorityArbiter, makeVisionBackMessage, makeHazardMessage, makeVisionLimitedMovingOnlyMessage } from "./arbiter";

describe("Recovery Policy - new behavior", () => {
  let speakCalls: Array<{ text: string; key: string; clipKey?: string; clipType?: string }> = [];
  let cancelCalls: number[] = [];
  let onDecisionCalls: any[] = [];

  let arbiter: PriorityArbiter;

  beforeEach(() => {
    speakCalls = [];
    cancelCalls = [];
    onDecisionCalls = [];

    const speakFn = (text: string, _language: "en" | "hi", key: string, _perf?: number, clipKey?: string, clipType?: string) => {
      speakCalls.push({ text, key, clipKey, clipType });
    };
    const cancelFn = (priority?: number) => {
      cancelCalls.push(priority ?? -1);
    };

    arbiter = new PriorityArbiter(speakFn, cancelFn, {
      onDecision: (decision, msg) => onDecisionCalls.push({ decision, msg: msg?.key }),
    });
  });

  it("degraded then ok with hazard in same frame: hazard speaks first, then Vision back after hazard ends, no cancel of Vision back", () => {
    // Step 1: First response - server_vision_limited (degraded)
    // This enqueues Vision limited moving-only (isStatus=true) and it gets spoken
    const visionLimited = makeVisionLimitedMovingOnlyMessage("en");
    arbiter.enqueue(visionLimited);
    // processQueue is called internally, speaks "Vision limited..."
    expect(speakCalls[0]?.text).toBe("Vision limited, moving-object alerts only");

    // Simulate speech start for "Vision limited, moving-object alerts only"
    arbiter.onSpeechStart(1);

    // Step 2: Second response - valid with hazard (recovery)
    // Recovery block enqueues Vision back (isRecovery=true) with clipKey/clipType undefined
    const visionBack = makeVisionBackMessage("en");
    arbiter.enqueue({ ...visionBack, isRecovery: true, clipKey: undefined, clipType: undefined });

    // Hazard extracted and enqueued (urgency 3 for center static hazard)
    const hazard = makeHazardMessage("pole", "center", "Pole ahead, stop", "en", 3, 0.9);
    arbiter.enqueue(hazard);

    // At this point, queue should have hazard first (urgency 3), then recovery
    const queueBeforeSpeak = (arbiter as any).queue.map((m: any) => ({
      key: m.key,
      isRecovery: m.isRecovery,
      urgency: m.urgency
    }));
    expect(queueBeforeSpeak.map((message: { key: string }) => message.key)).toEqual([
      "hazard:pole:center",
      "status:vision_back",
    ]);

    // Process queue while visionLimited is still speaking - should defer (P1 status speaking)
    arbiter.processQueueForTest();
    expect(speakCalls.length).toBe(1); // No new speech yet

    // Simulate visionLimited speech ending
    arbiter.onSpeechEnd();

    // Now process queue again - hazard should speak first (highest urgency)
    arbiter.processQueueForTest();

    // Should have spoken the hazard
    expect(speakCalls.length).toBe(2);
    expect(speakCalls[1]!.text).toBe("Pole ahead, stop");
    expect(speakCalls[1]!.key).toBe("hazard:pole:center");

    // Simulate hazard speech ending
    arbiter.onSpeechEnd();

    // Now process queue again - recovery should speak after hazard
    arbiter.processQueueForTest();

    // Should have spoken "Vision back" exactly once, after hazard
    expect(speakCalls.length).toBe(3);
    expect(speakCalls[2]!.text).toBe("Vision back");
    expect(speakCalls[2]!.key).toBe("status:vision_back");
    // Recovery should use plain TTS (no clip)
    expect(speakCalls[2]!.clipKey).toBeUndefined();
    expect(speakCalls[2]!.clipType).toBeUndefined();

    // No cancel of "Vision back" should have occurred
    expect(cancelCalls.filter(p => p === 1).length).toBe(0);

    // Verify decision log
    const spokenDecisions = onDecisionCalls.filter((c: any) => c.decision.type === "spoken");
    // Should have: visionLimited (normal), hazard (normal), vision_back (recovery_after_hazard)
    expect(spokenDecisions.length).toBe(3);
    expect(spokenDecisions[0].decision.reason).toBe("normal"); // visionLimited
    expect(spokenDecisions[1].decision.reason).toBe("normal"); // hazard
    expect(spokenDecisions[2].decision.reason).toBe("recovery_after_hazard"); // recovery after hazard
  });

  it("degraded then ok with no hazard: Vision back speaks immediately", () => {
    // Step 1: First response - server_vision_limited (degraded)
    const visionLimited = makeVisionLimitedMovingOnlyMessage("en");
    arbiter.enqueue(visionLimited);
    // processQueue is called internally, speaks "Vision limited..."
    expect(speakCalls[0]?.text).toBe("Vision limited, moving-object alerts only");

    // Simulate speech start
    arbiter.onSpeechStart(1);

    // Step 2: Second response - valid with NO hazard (recovery only)
    const visionBack = makeVisionBackMessage("en");
    arbiter.enqueue({ ...visionBack, isRecovery: true, clipKey: undefined, clipType: undefined });

    // No hazard enqueued

    // Process queue while visionLimited is still speaking - should defer (P1 status speaking)
    arbiter.processQueueForTest();
    expect(speakCalls.length).toBe(1); // No new speech yet

    // Simulate visionLimited speech ending
    arbiter.onSpeechEnd();

    // Now process queue - recovery should speak immediately (no hazards waiting)
    arbiter.processQueueForTest();

    // Should have spoken "Vision back" immediately after visionLimited
    expect(speakCalls.length).toBe(2);
    expect(speakCalls[1]!.text).toBe("Vision back");
    expect(speakCalls[1]!.key).toBe("status:vision_back");
    // Recovery should use plain TTS (no clip)
    expect(speakCalls[1]!.clipKey).toBeUndefined();
    expect(speakCalls[1]!.clipType).toBeUndefined();

    // Verify decision log
    const spokenDecisions = onDecisionCalls.filter((c: any) => c.decision.type === "spoken");
    console.log("Spoken decisions:", spokenDecisions.map((c: any) => c.decision.reason));
    // Should have: visionLimited (normal), vision_back (recovery_immediate)
    expect(spokenDecisions.length).toBe(2);
    expect(spokenDecisions[0].decision.reason).toBe("normal"); // visionLimited
    expect(spokenDecisions[1].decision.reason).toBe("recovery_immediate"); // recovery immediate
  });
});