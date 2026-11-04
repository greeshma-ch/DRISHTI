/** Debug test mimicking exact failing scenario - NEW POLICY: hazard speaks first, then Vision back. */
import { describe, it, expect, beforeEach } from "vitest";
import { PriorityArbiter, makeVisionBackMessage, makeHazardMessage, makeVisionLimitedMovingOnlyMessage } from "./arbiter";

describe("Arbiter Exact Scenario Debug - New Recovery Policy", () => {
  let speakCalls: Array<{text: string, key: string}> = [];
  let cancelCalls: number[] = [];
  let onDecisionCalls: any[] = [];

  let arbiter: PriorityArbiter;

  beforeEach(() => {
    speakCalls = [];
    cancelCalls = [];
    onDecisionCalls = [];

    const speakFn = (text: string, _language: "en" | "hi", key: string) => {
      speakCalls.push({ text, key });
    };
    const cancelFn = (priority?: number) => {
      cancelCalls.push(priority ?? -1);
    };

    arbiter = new PriorityArbiter(speakFn, cancelFn, {
      onDecision: (decision, msg) => onDecisionCalls.push({ decision, msg: msg?.key }),
    });
  });

  it("should speak hazard first, then Vision back - new policy", () => {
    // Step 1: First response - server_vision_limited (degraded)
    // This enqueues Vision limited moving-only (isStatus=true)
    const visionLimited = makeVisionLimitedMovingOnlyMessage("en");
    arbiter.enqueue(visionLimited);

    // Simulate speech start for Vision limited
    arbiter.onSpeechStart(1);

    console.log("After first enqueue:");
    console.log("  speakCalls:", speakCalls.map(c => c.text));
    console.log("  isSpeaking:", (arbiter as any).isSpeaking);
    console.log("  lastSpokenKey:", (arbiter as any).lastSpokenKey);
    console.log("  queue:", (arbiter as any).queue.map((m: any) => m.key));

    // Step 2: Second response - valid with hazard
    // Recovery block enqueues Vision back (isRecovery=true)
    const visionBack = makeVisionBackMessage("en");
    arbiter.enqueue({ ...visionBack, isRecovery: true });

    console.log("After recovery enqueue:");
    console.log("  speakCalls:", speakCalls.map(c => c.text));
    console.log("  isSpeaking:", (arbiter as any).isSpeaking);
    console.log("  queue:", (arbiter as any).queue.map((m: any) => ({ key: m.key, isRecovery: m.isRecovery, urgency: m.urgency })));

    // Step 3: Hazard extracted and enqueued
    const hazard = makeHazardMessage("pole", "center", "Pole ahead, stop", "en", 3, 0.9);
    arbiter.enqueue(hazard);

    console.log("After hazard enqueue:");
    console.log("  speakCalls:", speakCalls.map(c => c.text));
    console.log("  isSpeaking:", (arbiter as any).isSpeaking);
    console.log("  queue:", (arbiter as any).queue.map((m: any) => ({ key: m.key, isRecovery: m.isRecovery, urgency: m.urgency })));
    console.log("  onDecisionCalls:", onDecisionCalls.map(c => c.decision.type + ":" + (c.decision.reason || "")));

    // Process queue while Vision limited is still speaking - should defer (P1 status speaking)
    arbiter.processQueueForTest();
    expect(speakCalls.length).toBe(1); // No new speech yet

    // Simulate Vision limited speech ending
    arbiter.onSpeechEnd();

    // Now process queue again - hazard should speak first (highest urgency)
    arbiter.processQueueForTest();

    // Should have spoken the hazard first
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

    // Verify decision log
    const spokenDecisions = onDecisionCalls.filter((c: any) => c.decision.type === "spoken");
    expect(spokenDecisions.length).toBe(3);
    expect(spokenDecisions[0].decision.reason).toBe("normal"); // visionLimited
    expect(spokenDecisions[1].decision.reason).toBe("normal"); // hazard
    expect(spokenDecisions[2].decision.reason).toBe("recovery_after_hazard"); // recovery after hazard
  });
});