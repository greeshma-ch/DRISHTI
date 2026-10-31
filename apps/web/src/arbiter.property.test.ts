/** Priority Arbiter property-based tests using fast-check.
 * Tests pure factory functions - stateful arbiter behavior tested in arbiter.test.ts */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  makeHazardMessage,
  makeNavMessage,
  makeAdvisoryMessage,
  makeEmergencyMessage,
  makeVisionPausedMessage,
  makeVisionBackMessage,
  makeVisionLimitedMessage,
} from "./arbiter";

// Generator for non-empty, trimmed strings (valid identifiers)
const nonEmptyString = () =>
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0).map((s) => s.trim());

// Generator for valid language values
const languageGen = fc.constantFrom("en", "hi");

// Generator for hazard types (alphanumeric only to avoid key issues)
const hazardTypeGen = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z0-9_]+$/.test(s));
const directionGen = fc.constantFrom("left", "center", "right");

describe("PriorityArbiter factory function properties (pure functions)", () => {
  describe("makeHazardMessage", () => {
    it("always creates P1 with hazard key and 2s TTL", () => {
      fc.assert(
        fc.property(
          hazardTypeGen,
          directionGen,
          nonEmptyString(),
          languageGen,
          fc.integer({ min: 0, max: 3 }),
          fc.float({ min: 0, max: 1 }),
          (hazardType, direction, text, language, urgency, confidence) => {
            const msg = makeHazardMessage(hazardType, direction, text, language, urgency, confidence);

            expect(msg.priority).toBe(1);
            expect(msg.key).toBe(`hazard:${hazardType}:${direction}`);
            expect(msg.ttlMs).toBe(2000);
            expect(msg.language).toBe(language);
            expect(msg.text).toBe(text);
            expect(msg.clipType).toBe("hazards");
            expect(msg.clipKey).toContain(`${hazardType.toLowerCase()}:${direction.toLowerCase()}:`);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("clipKey contains hazard type, direction, and clearSide", () => {
      fc.assert(
        fc.property(
          hazardTypeGen,
          directionGen,
          nonEmptyString(),
          languageGen,
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9_]+$/.test(s)),
          (hazardType, direction, text, language, clearSide) => {
            const msg = makeHazardMessage(hazardType, direction, text, language, 2, 0.9, undefined, clearSide);
            expect(msg.clipKey).toBe(`${hazardType.toLowerCase()}:${direction.toLowerCase()}:${clearSide.toLowerCase()}`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("makeNavMessage", () => {
    it("always creates P2 with nav key and 10s TTL", () => {
      fc.assert(
        fc.property(
          nonEmptyString(),
          languageGen,
          nonEmptyString(),
          (text, language, key) => {
            const msg = makeNavMessage(text, language, key);

            expect(msg.priority).toBe(2);
            expect(msg.key).toBe(`nav:${key}`);
            expect(msg.ttlMs).toBe(10000);
            expect(msg.language).toBe(language);
            expect(msg.text).toBe(text);
            expect(msg.clipKey).toBeUndefined();
            expect(msg.clipType).toBeUndefined();
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("makeAdvisoryMessage", () => {
    it("always creates P3 with adv key and 15s TTL", () => {
      fc.assert(
        fc.property(
          nonEmptyString(),
          languageGen,
          nonEmptyString(),
          (text, language, key) => {
            const msg = makeAdvisoryMessage(text, language, key);

            expect(msg.priority).toBe(3);
            expect(msg.key).toBe(`adv:${key}`);
            expect(msg.ttlMs).toBe(15000);
            expect(msg.language).toBe(language);
            expect(msg.text).toBe(text);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("makeEmergencyMessage", () => {
    it("always creates P0 with no TTL", () => {
      fc.assert(
        fc.property(
          nonEmptyString(),
          languageGen,
          (text, language) => {
            const msg = makeEmergencyMessage(text, language);

            expect(msg.priority).toBe(0);
            expect(msg.key).toBe("emergency");
            expect(msg.ttlMs).toBe(0);
            expect(msg.language).toBe(language);
            expect(msg.text).toBe(text);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("status message factories", () => {
    it("makeVisionPausedMessage has correct structure", () => {
      fc.assert(
        fc.property(
          languageGen,
          (language) => {
            const msg = makeVisionPausedMessage(language);

            expect(msg.priority).toBe(1);
            expect(msg.isStatus).toBe(true);
            expect(msg.key).toBe("status:vision_paused");
            expect(msg.clipType).toBe("system");
            expect(msg.clipKey).toBe("vision_paused");
            expect(msg.language).toBe(language);
            expect(typeof msg.text).toBe("string");
            expect(msg.text.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("makeVisionBackMessage has correct structure", () => {
      fc.assert(
        fc.property(
          languageGen,
          (language) => {
            const msg = makeVisionBackMessage(language);

            expect(msg.priority).toBe(1);
            expect(msg.isStatus).toBe(true);
            expect(msg.key).toBe("status:vision_back");
            expect(msg.clipType).toBe("system");
            expect(msg.clipKey).toBe("vision_back");
            expect(msg.language).toBe(language);
            expect(typeof msg.text).toBe("string");
            expect(msg.text.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("makeVisionLimitedMessage has correct structure", () => {
      fc.assert(
        fc.property(
          languageGen,
          (language) => {
            const msg = makeVisionLimitedMessage(language);

            expect(msg.priority).toBe(1);
            expect(msg.isStatus).toBe(true);
            expect(msg.key).toBe("status:vision_limited");
            expect(msg.clipType).toBe("system");
            expect(msg.clipKey).toBe("vision_limited");
            expect(msg.language).toBe(language);
            expect(typeof msg.text).toBe("string");
            expect(msg.text.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("status messages have Hindi variants", () => {
      expect(makeVisionPausedMessage("hi").text).toBe("दृष्टि रुकी");
      expect(makeVisionBackMessage("hi").text).toBe("दृष्टि वापस");
      expect(makeVisionLimitedMessage("hi").text).toBe("दृष्टि सीमित");
    });
  });
});