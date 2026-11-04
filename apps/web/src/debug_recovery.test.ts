/** Debug test for recovery + hazard scenario - NEW POLICY: hazard speaks first, then Vision back. */
import { describe, it, expect, beforeEach } from "vitest";
import { PriorityArbiter, makeVisionBackMessage, makeHazardMessage, makeVisionLimitedMovingOnlyMessage } from "./arbiter";

describe("Arbiter Recovery + Hazard Debug - New Recovery Policy", () => {
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

  it("should speak hazard first, then Vision back when both enqueued during status speech", () => {
    // Simulate "Vision limited" speaking (P1 status)
    const visionLimited = makeVisionLimitedMovingOnlyMessage("en");
    arbiter.enqueue(visionLimited);

    // Simulate speech start
    arbiter.onSpeechStart(1);

    // Now enqueue recovery + hazard (simulating recovery response with hazard)
    const visionBack = makeVisionBackMessage("en");
    const hazard = makeHazardMessage("pole", "center", "Pole ahead, stop", "en", 3, 0.9);

    arbiter.enqueue({ ...visionBack, isRecovery: true });
    arbiter.enqueue(hazard);

    // Process queue while Vision limited is still speaking - should defer (P1 status speaking)
    arbiter.processQueueForTest();
    expect(speakCalls.length).toBe(1); // No new speech yet

    console.log("Speak calls:", speakCalls.map(c => c.text));
    console.log("Queue:", (arbiter as any).queue.map((m: any) => ({ key: m.key, isRecovery: m.isRecovery, urgency: m.urgency })));
    console.log("isSpeaking:", (arbiter as any).isSpeaking);
    console.log("currentUtterancePriority:", (arbiter as any).currentUtterancePriority);
    console.log("onDecisionCalls:", onDecisionCalls.map(c => c.decision.type + ":" + (c.decision.reason || "")));

    // Simulate Vision limited speech ending
    arbiter.onSpeechEnd();

    // Now process queue - hazard should speak first (urgency 3)
    arbiter.processQueueForTest();

    // Should have spoken the hazard
    expect(speakCalls.length).toBe(2);
    expect(speakCalls[1]!.text).toBe("Pole ahead, stop");
    expect(speakCalls[1]!.key).toBe("hazard:pole:center");

    // Simulate hazard speech ending
    arbiter.onSpeechEnd();

    // Now process queue - recovery should speak after hazard
    arbiter.processQueueForTest();

    // Should have spoken "Vision back" after hazard
    expect(speakCalls.length).toBe(3);
    expect(speakCalls[2]!.text).toBe("Vision back");
    expect(speakCalls[2]!.key).toBe("status:vision_back");
  });
});