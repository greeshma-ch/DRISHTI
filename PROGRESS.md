# PROGRESS.md: Drishti

Handoff log. Read at the start of every session, update before you stop.
Times are IST. Kickoff Oct 26, 9:30 PM. Internal freeze Nov 4, 6:00 PM. Official deadline Nov 5, 7:30 AM.

## Scope (locked unless a trade-off is written below)

**Must:** hazard alerts with direction, navigation to a spoken destination fused with hazards,
emergency flow, personalization (Hindi and English, tone, verbosity, steps), evaluation on recorded clips.
**Stretch (only if core is stable by Nov 1):** "what's nearby" voice query, phone-sensor fall detection.
**Roadmap only:** place recommendations with ambience checks, native Ray-Ban Meta glasses app.

## Pre-kickoff checklist (before Oct 26, 9:30 PM)

- [ ] Meta Model API key works from India (one text call, one image call); latency noted
- [ ] SAM 3.1 tested on one street photo; latency noted
- [ ] Image token count measured for a 640x360 frame (and 512x288); budget numbers recomputed
- [ ] hi-IN TTS voice and Hindi speech-to-text checked on the demo phone
- [ ] Repo created; AGENTS.md and PROGRESS.md committed; `.env.example` added
- [ ] Discord joined; workshop schedule and official rules read
- [ ] Telegram bot created; token saved to `.env`
- [ ] Chest strap or lanyard mount found; 2 filming routes planned

## Compressed schedule (IST, restarted Oct 29)

| Date | Prompts | Goal | Status |
|---|---|---|---|
| Oct 29 (today) | Setup, P0, P1, P2 | Bootstrap, walking skeleton (camera -> server -> Meta -> speech), arbiter v1 & phrase table | [x] P0, P1 done |
| Oct 30 | P3, P4 | P3: Tier 1 on-device detector; P4: Tier 2 hardening, rate limiter, spend guard | [ ] |
| Oct 31 | P5, P6 | P5: Navigation; P6: Emergency flow, profile & onboarding, "what's nearby" | [ ] |
| Nov 1 | P7 | Evaluation harness. Gate: walk outdoors with live alerts; SAM decision | [ ] |
| Nov 2 | P8, P9a | Reliability hardening, soak test, memory & semantic search (if gate passed) | [ ] |
| Nov 3 | P9-lite, freeze | Accessible UI, saved places, feature freeze, film demo footage | [ ] |
| Nov 4 | Submit | Demo edit, README, architecture diagram, submit by 6:00 PM IST | [ ] |

## Credit budget ($150 cap, Meta Model API)

Assumptions to verify on Day 1: Spark about 1,000 input + 120 output tokens per frame call
(about $0.0018); SAM 3.1 about $0.0025 per image; voice transcription about $0.18 per audio hour.

| Line | Plan | Est. |
|---|---|---|
| Dev on recorded clips and cached stills | replay and cache | $8 |
| Live outdoor testing | 6 h cap | $33 |
| Eval runs | about 6 billed runs, rest from cache | $15 |
| Field tests and demo recording | about 4 h | $22 |
| Voice transcription and text calls | | $6 |
| Prompt and SAM exploration | | $10 |
| **Planned total** | | **$94** |
| Reserve (final eval and demo) | | $30 |
| Slack | | $26 |

Throttle levels are defined in AGENTS.md (warn $60, throttle $90, block dev calls above $120).

### Spend log

| Date | Activity | Calls | Est. cost | Running total |
|---|---|---|---|---|
| Oct 31 | P1 live verification + in-flight benchmark (40 frames) | ~200 | $0.62 | $0.62 |

## Decision log

| Date | Decision | Why |
|---|---|---|
| Oct 26 | Phone-first on a chest strap or lanyard; glasses-ready design, no native glasses app | No glasses available |
| Oct 26 | Demo languages: Hindi and English | Chosen by builder |
| Oct 26 | Urgent alerts use a fixed phrase table, not free LLM text | Latency, predictability, Hindi grammar control |
| Oct 26 | Tier 2 at about 0.5 fps by default, adaptive up to 1 fps | Credit cap |
| Oct 31 | Output tokens cut to 150; single most urgent hazard returned | Cut Meta latency to median 1.84s (from 2.8s) |
| Oct 31 | Tier 2 max_tokens raised to 450 with retry at 700; never speak "path clear" | Fix safety bug: reasoning tokens hit cutoff causing false "path clear" |
| Oct 31 | Specific hazard phrase table restored without free-text generation | 18 hazard types, clear_side avoidance action, label for other, <= 4 words |

## Current session

- Working on: P2 Priority arbiter and queuing (COMPLETED), Task 5 Client watchdog (COMPLETED), Task 6 Shared phrases (COMPLETED), Task 7 Audio clips (COMPLETED), Task 8 Soft tick (COMPLETED), Task 9 Demo page (COMPLETED), Task 10 Property tests (COMPLETED), Task 11 Phase numbering fix (COMPLETED), Task 12 Refined P1 rate-limit policy (COMPLETED)
- Done this session:
  - `apps/web/src/arbiter.ts` (new):
    - PriorityArbiter class with P0-P3 priorities (emergency, hazard, nav, advisory)
    - Message queue with interrupt semantics per AGENTS.md
    - Dedupe same hazard type+direction for 4s
    - Rate limit: max 1 hazard utterance per 1.5s (status messages excluded)
    - TTL: hazard 2s, nav 10s, advisory 15s, emergency no TTL
    - P0 interrupts everything immediately (never queued)
    - P1 interrupts P2/P3 mid-sentence
    - Status messages (vision paused/back/limited) are P1 with isStatus flag
    - Status messages not held by hazards > 3s (interrupt after max wait)
    - Factories: makeHazardMessage, makeNavMessage, makeAdvisoryMessage, makeEmergencyMessage, makeVisionPausedMessage, makeVisionBackMessage, makeVisionLimitedMessage
  - `apps/web/src/App.tsx`:
    - Integrated PriorityArbiter replacing direct speak() calls
    - Hazard messages enqueued via makeHazardMessage with urgency/confidence
    - Vision watchdog: tracks consecutive fetch failures (3 = Vision paused)
    - On recovery: announces "Vision back" (debounced 10s)
    - In degraded mode: periodic "Vision limited" every 15s
    - Arbiter initialized in startVision, cleared in stopVision
    - Speech timing (responseReceivedPerfMs) passed through for debug overlay
  - `apps/web/src/arbiter.test.ts` (37 passing tests):
    - Comprehensive test coverage for all arbiter behavior including status message interrupt
    - **Refined P1 rate-limit policy tests (8 new tests):**
      - Different-key hazards (pole-left after vehicle-right) are queued as "next" when P1 speaking, no rate limit
      - Same-key hazards rate limited to 1.5s minimum interval
      - Same-key repeat within 1.5s dropped at enqueue
      - Urgency 3 interrupts a speaking P1 immediately
      - At most one queued P1 (latest wins by timestamp desc for same urgency)
      - Higher urgency P1 replaces lower urgency queued P1
      - Same key within 4s dedupe window dropped at enqueue
      - Same key after 4s dedupe window allowed
  - `apps/web/src/App.test.tsx` (5 passing tests) & `server/tests/test_frame.py` (24 passing tests):
    - All existing tests pass with arbiter integration
  - `shared/phrases.json` (updated):
    - Single source of truth for all phrases (nouns, directions, avoid_actions, system_messages)
  - `apps/web/src/phrases.ts` (updated):
    - Loads phrase tables from shared/phrases.json via @shared alias
    - Exports NOUNS, DIRECTIONS, AVOID_ACTIONS, SYSTEM_MESSAGES, buildPhrase, getSystemMessage
  - `apps/web/src/arbiter.ts` (updated):
    - Status message factories now use SYSTEM_MESSAGES from shared phrases
  - `server/phrases.py` (updated):
    - Loads phrase tables from shared/phrases.json at module import
    - Exports NOUNS, DIRECTIONS, AVOID_ACTIONS, SYSTEM_MESSAGES, build_phrase, get_system_message
  - `apps/web/vite.config.ts` & `tsconfig.json`:
    - Added @shared path alias for shared directory
  - `apps/web/src/audio.ts` (new):
    - Audio manifest loader for pre-rendered clips
    - playClipOrTTS with TTS fallback for hazard and system phrases
    - stopClip for interruption support
    - getHazardClipKey, getSystemClipKey, hasClip, preloadClip utilities
    - playSoftTick using Web Audio API (gentle 800 Hz sine wave, 200ms)
  - `apps/web/public/audio/manifest.json`:
    - Manifest mapping all hazard type:direction:clear_side combinations to audio files
    - System message keys: vision_paused, vision_back, vision_limited, emergency_triggered, emergency_cancelled
  - `apps/web/src/arbiter.ts` (updated):
    - Factory functions now populate clipKey and clipType for all message types
  - `apps/web/src/App.tsx` (updated):
    - arbiterSpeak callback uses playClipOrTTS with TTS fallback
    - arbiterCancel stops both speechSynthesis and audio clips
    - Soft tick every 8s with UI toggle (only when vision running and not speaking)
    - New onStart/onEnd callbacks in playClipOrTTS for proper arbiter lifecycle
    - Hash-based router with /#demo page for priority arbiter testing
    - DemoPage component with P0/P1/P2/P3 buttons, language selector, queue visualization
    - **Fixed intermittent Android Chrome interruption bug**: Added utterance generation counter to prevent stale onend/onerror handlers from clearing arbiter state after cancel. cancelFn now takes priority, waits ~50ms for P0/P1 after cancel, bumps generation counter. Event handlers check generation before updating state. Added event logging (last 30 lines) on demo page.
    - `apps/web/src/arbiter.ts` (updated): cancelFn now accepts optional priority parameter; all cancel call sites pass current/next priority.
    - `apps/web/src/DemoPage.integration.test.tsx` (new test): 5-cycle P3→P1 interrupt test simulates late onend from cancelled utterance; all 5 cycles pass.
  - **Refined P1 rate-limit policy implementation (Task 12):**
    - `apps/web/src/arbiter.ts`: Rate limit (1.5s) and dedupe (4s) now apply ONLY to same-key repeats (same hazard type + direction). Different-key P1s or higher urgency P1s are never dropped — they interrupt P2/P3 immediately, or queue as "next" (max 1 queued, TTL 2s) when P1 is speaking. Urgency 3 always interrupts a speaking P1 immediately. Only same-key repeats and expired messages are dropped.
    - `apps/web/src/arbiter.test.ts`: Added 8 new tests covering the refined policy
    - `apps/web/src/arbiter.stateful.test.ts`: Updated property test to only check 4s dedupe window for same-key hazards (1.5s interval not testable with fake speech engine)
    - All 67 tests pass (37 arbiter unit tests + 6 property tests + 9 property tests + 5 App tests + 9 integration tests + 1 smoke test)
- Next: All P2 tasks complete (arbiter, watchdog, shared phrases, audio clips, soft tick, demo page, property tests, phase numbering fix, refined P1 rate-limit policy)
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
