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
| Oct 30 | P3, P4 | P3: Tier 1 on-device detector; P4: Tier 2 hardening, rate limiter, spend guard | [x] P3, P4 done |
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
| Nov 01 | Tier 1 Stall Recovery & Decision Labeling | Automatic stall recovery (waiting/stalled/pause -> wait canplay -> play; abort 3 failed recoveries or 8s no progress); 320px capture downscaling; >854px warning with ffmpeg downscale command; decision row labeling buttons (True/False alert, Correct silence/Should have alerted), bulk "Mark all unlabeled as correct", "+ Mark Missed" hazard logging; live summary metrics (TP, FP, TN, FN, alerts/min, precision, recall) and CSV export |

## Current session

- Working on: P4 Tier 2 Hardening, Circuit Breaker, Rate Limiter, Spend Guard (COMPLETED)
- Done this session:
  - **Circuit Breaker** (`server/circuit_breaker.py`):
    - Module-level state with asyncio.Lock (single-worker assumption documented)
    - 3-failure threshold, 30s open duration, 8s timeout per attempt
    - Tracks: timeouts, connection errors, Meta 5xx, Meta 429
    - Valid empty-hazard response = success (resets failure count)
    - Half-open after 30s: one test call, success closes, failure reopens
    - Returns degraded result (`status=degraded, reason=circuit_open`) when open
    - Closes coroutine when circuit open to avoid "never awaited" warnings
  - **Token Bucket Rate Limiter** (`server/rate_limiter.py`):
    - stdlib sqlite3 with WAL mode, persists to `eval/rate_limits.sqlite`
    - Per-user (X-User-Id header, fallback to client IP) and per-endpoint buckets
    - Endpoints: frame (1.2/s, burst 3), chat (10/min, burst 10), geocode (1/s global, burst 1)
    - Exempt: /health, /status, /spend, /emergency/*
    - Returns 429 with Retry-After header (seconds)
    - Prunes rows older than 24h at startup
    - SQLite persistence across restarts
  - **Spend Guard** (`server/meta_client.py`, `server/app.py`):
    - In-memory running total loaded from `eval/spend.jsonl` at startup (survives restarts)
    - Throttle levels: <$60 normal, $60-90 warn, $90-120 throttle, >$120 blocked
    - At $90: `/frame` includes `suggested_interval_ms=4000`
    - At $120: blocks non-FINAL_RUN calls, returns degraded (`reason=spend_blocked`)
    - `FINAL_RUN=True` bypasses spend block
    - `/spend` endpoint returns level, total_usd, prices_used dict
  - **Hedged Wording** (`server/phrases.py`):
    - Confidence < 0.6: prefixes "possible " / "संभावित " (EN/HI)
    - Never adds "possible" to Stop phrases (e.g., "Vehicle ahead, stop" unchanged)
    - Phrase length ≤ 4 words (truncated after prefix)
  - **Server Integration** (`server/app.py`, `server/meta_client.py`, `server/config.py`):
    - P4 settings added: circuit breaker, rate limiter, spend thresholds, confidence threshold
    - `/frame` endpoint: rate limiter check at start, spend guard, circuit breaker integration
    - Degraded result format: `status=degraded` with `reason` (circuit_open|spend_blocked|rate_limited)
  - **Fault Injection Tests** (`server/tests/test_fault_injection.py`):
    - 14 tests covering 10 failure modes + circuit breaker state + FINAL_RUN bypass
    - Each test mocks Meta API failure and verifies expected spoken message exactly once
    - Meta 500, timeout, 429, malformed JSON, connection error → "Vision limited..." after 3 failures
    - Circuit open → degraded immediately, client handles Retry-After, speaks once
    - Spend >$120 → blocked, degraded result
    - Valid empty hazard → silence (Hard Rule 1)
    - Valid hazard → phrase spoken (confidence ≥0.6 normal, <0.6 hedged)
  - **Unit Tests**:
    - `test_circuit_breaker.py`: 8 tests (open/close/half-open, success resets, concurrent safety)
    - `test_rate_limiter.py`: 10 tests (burst/sustained, persistence, prune, exempt endpoints)
    - `test_spend_guard.py`: 7 tests (levels, startup loading, restart survival, suggested_interval_ms)
    - `test_hedged_wording.py`: 9 tests (EN/HI hedging, Stop exception, phrase length, parse integration)
    - `test_fault_injection.py`: 14 tests (all 10 failure modes + CB state + FINAL_RUN)
  - **Client Tests** (`apps/web/src/client_network_failure.test.tsx`):
    - 6 tests: network failures, 429 handling, suggested_interval_ms, no duplication
    - Network error/timeout → "Vision limited..." after 2 consecutive failures OR 4s backoff
    - Recovery → "Vision back"
  - **Scripted Breaker Demo** (`scripts/demo_breaker.py`):
    - Demonstrates full CB lifecycle: CLOSED → 3 failures → OPEN → 30s → HALF-OPEN → success → CLOSED
    - Verifies spoken messages: "Vision limited..." once, "Vision back" on recovery
  - **Testing & Verification**:
    - `pytest server/tests/`: 74 passed
    - `vitest run`: 127 passed
    - `tsc --noEmit`: clean
    - `eslint`: clean (pre-existing warnings only)
  - **Vision recovery follow-up (Nov 3)**:
    - Recovery TTS bypasses async audio-manifest loading to prevent a same-frame hazard clip request from canceling “Vision back”.
    - Updated center-static stop phrase expectations and cleaned TypeScript diagnostics in recovery tests.
    - Verified: `pytest server/tests/` — 74 passed; `vitest run` — 136 passed; `tsc --noEmit` — clean.
- **Vision recovery fix (Nov 4)**:
    - Root cause identified: arbiter's P1 queue sorted by urgency desc, so a co-enqueued hazard (urgency 3) preempted “Vision back” (urgency 0) in the same recovery frame.
    - Fixes applied:
      1. Added `isRecovery` flag to `ArbiterMessage` and `recovery_interrupts_status` decision reason.
      2. Recovery messages now speak immediately (`recovery_immediate`), bypassing dedupe/rate-limit, and interrupt any active P1 status.
      3. Queue sorting prioritizes recovery over hazards when both are P1.
      4. Removed `ttsOnly` bypass; recovery messages pass `clipKey: undefined, clipType: undefined` to skip manifest loading.
      5. Phrase table updated: `avoid_actions.none = { en: “stop”, hi: “रुकें” }` for center static hazards (Rule 8 clarified: “stop” allowed for static obstacles).
    - Verified: `pytest server/tests/` — 74 passed; `vitest run` — 136 passed; `tsc --noEmit` — clean; ESLint 0 errors.
- **Test hardening & Vision status UI (Nov 4)**:
    - Fixed failing DemoPage integration test (P3/P1 interrupt cycle) by adding proper cleanup of P1 utterance onend.
    - Fixed all TypeScript errors: made `processQueueForTest()` public on `PriorityArbiter` for test access; added non-null assertions where length checks guarantee presence; fixed Worker mock typing.
    - Rendered Vision Status event log on **both** MainApp and DemoPage under a “Vision Status Events” heading with timestamp, event, and reason columns; added “Copy log” button.
    - Recovery policy tests pass: hazard first, then “Vision back” exactly once; no hazard means “Vision back” speaks immediately.
    - Verified: `npm test` — 138 passed; `tsc --noEmit` — clean; `pytest server/tests/` — 74 passed.
- Next: P5 Navigation, P6 Emergency flow, profile & onboarding
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
