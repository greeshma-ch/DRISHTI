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
| Oct 30 | P3, P4 | P3: Tier 1 on-device detector; P4: Tier 2 hardening, rate limiter, spend guard | [x] P3 done |
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
| Nov 01 | Tier 1 local COCO-SSD detector (P3) | Web Worker offline model, per-second closing speed, path relevance (center-only for static), 2-frame debounce, re-announce worsening/10s, /#tier1 review |
| Nov 01 | P3 Real-Phone Safety & Hardening | AGENTS.md Rule 8 (no lateral moves for moving hazards); caution+position phrases; 4-frame debounce, 3 consecutive closing steps; side-passing silent; lens blocked & dark frame detection; Tier 2 exponential backoff (2,4,8,15s) with single Vision limited alert; 320px downscaled WebGL worker |
| Nov 01 | P3 Verification & Live Benchmarking | Removed placeholder benchmark table; added live 100-frame browser benchmark (WebGL & WASM with SIMD, 256/320px); live clip evaluation tool for alerts/min; "Camera blocked or too close, stop" halting alert; verified against white wall, dim corridor, shaded street |
| Nov 01 | Tier 1 Slow-Phone Hardening & Verifiable Decisions | Time-based rules (0.8s tracked, 0.6s sustained closing; vehicle alerts in 0.8s <= 1.5s @ 2.5 FPS); decision logging (alerted vs suppressed) & CSV export; live clip pipeline; 192/256px resolution; skip Tier 2 when busy/blocked; stairs prompt & verification script |
| Nov 01 | Tier 1 Deterministic Stepper & Evaluation (Task A) | Deterministic 0.25s video stepper via seeked events; stall detector (2s timeout); deduplicated decision logs (logged on state change); capped 200 row display; missed hazard logging; HEVC alert banner |
| Nov 01 | Tier 2 Truncation Reduction & Monitoring (Task B) | First attempt max_tokens=800, retry=1200; shortened prompt with one-line JSON example; retries/total frames and median reasoning tokens in /status and Debug Overlay; >10% retry warning |
| Nov 01 | Tier 1 Android Chrome Hardware Sampling & Telemetry | requestVideoFrameCallback (rVFC) sampling at playbackRate 1, muted, 0.4s default; seek fallback; loadeddata gate; video diagnostics HUD (readyState, networkState, errors, dimensions, 10 events); whole-clip evaluation with alert True/False/Missed marking & CSV export |

## Current session

- Working on: Android Chrome Tier 1 Fix (requestVideoFrameCallback, Diagnostics, loadeddata gate, Whole Clip Eval) (COMPLETED)
- Done this session:
  - **Video Pipeline Diagnostics HUD (Item 1)**:
    - Displayed live `video.readyState` (with mapped descriptions `0: HAVE_NOTHING` to `4: HAVE_ENOUGH_DATA`).
    - Displayed `video.networkState`, `video.error` code/message, duration, and resolution (`videoWidth x videoHeight`).
    - Displayed rolling telemetry buffer of the last 10 media events (`loadeddata`, `seeking`, `seeked`, `canplay`, `stalled`, `error`, etc.) with timestamps.
  - **Clip Loading & loadeddata Gate (Item 2)**:
    - Clips loaded via `URL.createObjectURL(file)`.
    - Added required attributes: `muted`, `playsInline`, `preload="auto"`.
    - Gated all control buttons (`Run Clip Evaluation`, `Play Sampling`, `Cancel`, `+ Mark Missed Hazard`) to remain disabled until `loadeddata` event fires.
  - **requestVideoFrameCallback Sampling with Seek Fallback (Item 3)**:
    - Implemented `VideoClipSampler`: plays video muted at `playbackRate = 1.0` and samples frames via `requestVideoFrameCallback` only when `mediaTime` advances by `sampleIntervalSec` (default 0.4s, adjustable) AND `detector.isBusy()` is false.
    - Used `mediaTime` directly as the timestamp for tracking, closing speed calculations, and time-based rules.
    - Automatic fallback to seek-based stepper when `requestVideoFrameCallback` is unsupported.
    - 2.0 s stall watchdog reporting `"video stalled at t=..."`.
  - **Whole Clip Automatic Evaluation & Alerts Marking (Item 4)**:
    - "Run Clip Evaluation" executes entire clip automatically through detector, tracker, and live `PriorityArbiter`.
    - Removed "Before vs After" comparison panel and `+/-0.25 s` buttons.
    - Shows alert list with dedicated **True / False / Missed** annotation buttons and **Export Alerts CSV** button.
  - **Testing & Verification (Item 5)**:
    - 12 comprehensive unit tests in `apps/web/src/tier1/eval_stepper.test.ts` covering mocked video events for both paths, stall reporting, and decision change deduplication.
    - `vitest run`: 112 passed across 8 test suites.
    - `tsc --noEmit`: 0 errors.
    - `npm run lint`: 0 errors.
    - `npm run build`: built in 14.20s.
    - `pytest server/tests`: 28 passed.
- Next: P4 Tier 2 hardening, rate limiter, spend guard.
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
