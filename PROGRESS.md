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
| Nov 02 | Offline Eval Independence & Tier 2 Recall on Labeled Misses | Deterministic 0.4s sample stepper (playToNextSample, pause, detect, record, resume); gap-tolerant tracking up to 1.0s; sample spacing stats (min/med/max with >0.6s warning); check_clip_hazards.py --csv for labeled misses (±1.5s window); measured rerun of clip_001 and clip_006 |
| Nov 03 | P4 Tier 2 Hardening, Rate Limiter & Circuit Breaker | 3-state circuit breaker, sliding-window rate limiter, spend guard at $60/$90/$120, fault injection tests, vision recovery policies |
| Nov 04 | Tier 1 Fast-Closing Override & Tracker Identity Gate | Fast-closing override (0.15 height growth or >0.20/s, h>=0.40, 2 frames) with caution phrasing; tracker identity gate (3.0x height, 9.0x area); review page telemetry HUD and console error capture |

## Current session

- Working on: Merging P3 Tier 1 Enhancements & Diagnostics with P4 Tier 2 Hardening & Vision Recovery (COMPLETED)
- Done this session:
  - **P3 Tier 1 Enhancements & Verification**:
    - **Offline Evaluation Device-Speed Independence**:
      - Updated `eval_stepper.ts` and `Tier1ReviewPage.tsx` with deterministic step-and-pause offline evaluation: plays forward to next sample time via `playToNextSample(targetTime)`, pauses immediately, runs detector to completion, records result, and resumes.
      - Samples evaluated on an exact 0.4 s grid (`targetTime = 0.0, 0.4, 0.8, ...`) in `mediaTime`, completely decoupling offline eval from mobile/desktop processor speed.
      - Added sample spacing telemetry (`computeSampleSpacingStats`): calculates `min`, `median`, and `max` sample spacing in seconds across all steps.
      - Displayed spacing stats prominently on the review page HUD with an alert warning banner if `median > 0.6s`.
    - **Live Mode Gap Tolerance**:
      - Updated `updateTracker` in `apps/web/src/tier1/math.ts`:
        - Centroid distance and IoU matching thresholds now scale proportionally with sample gap: `gapScale = Math.max(1.0, gap / nominalInterval)` (`nominalInterval = 0.25s`).
        - Centroid distance threshold scales up to 0.65; IoU threshold scales down to 0.05.
        - Tracks persist across ~0.5s gaps (tested at 0.5s and 0.8s), preserving track ID, incrementing `consecutiveFrames`, and accumulating `trackedDuration`.
        - Maximum gap before track drop enforced at 1.0 s (`gap > 1.0s`).
    - **Tier 2 Perception Verification on Labeled Misses**:
      - Extended `scripts/check_clip_hazards.py` with `--csv <path>` argument to read exported labeled decision logs.
      - Filters rows marked as `missed_hazard` or `Should have alerted`, extracts frames at $t-1$, $t$, and $t+1$ s downscaled to 640 px wide with OpenCV, and calls `/frame` on each.
      - Evaluates semantic match within $\pm 1.5$ s window and formats table: `clip, t, expected, Tier 2 type & dir, dist, urg, latency, retries, hit/miss`.
      - Outputs Tier 2 recall summary table broken down by hazard type (`stairs`, `wall`, `person`, `vehicle`).
    - **Ground Truth Corrections & Strict Verification**:
      - Deleted synthetic misses ($t=14.80, 21.20, 32.40$) and removed automated ground-truth labeling (`d.label = "Correct silence"`) from `apps/web/src/tier1/run_clip_eval.ts`. Unlabeled rows remain unlabeled (`""`) and are excluded from TN, FP, and precision metrics.
      - Ground truth loaded strictly from user-provided CSVs: `eval/clip_006_mp4_tier1_decisions_1793559223689.csv` (misses at $6.28$ other center, $15.90$ other right, $18.11$ stairs center, $34.61$ stairs center) and `eval/clip_001_mp4_tier1_decisions.csv` (misses at $11.50$ person right, vehicle right).
      - Extended `scripts/check_clip_hazards.py` to evaluate both **Strict Hit** (exact semantic type match) and **Loose Hit** (any valid hazard in the expected direction) within a $\pm 1.5$ s window.
      - Measured Tier 2 Perception on user `clip_006` misses:
        - $t=6.28$s other (center): Tier 2 detected `stairs(center)` (t=6.3s, 7.3s), dist=near, urg=2, latency=7440ms, retries=0/1 -> Strict: MISS, Loose: **HIT**
        - $t=15.90$s other (right): Tier 2 detected `stairs(center)` (t=15.9s, 16.9s), dist=near, urg=3, latency=4274ms, retries=0/6 -> Strict: MISS, Loose: **HIT**
        - $t=18.11$s stairs (center): Tier 2 detected `stairs(center)` (t=17.1s, 18.1s), dist=near, urg=2, latency=3129ms, retries=0/7 -> Strict: **HIT**, Loose: **HIT**
        - $t=34.61$s stairs (center): Tier 2 detected `stairs(center)` (t=34.6s, 35.6s), dist=near, urg=2, latency=4729ms, retries=0/11 -> Strict: **HIT**, Loose: **HIT**
        - Summary: Stairs strict recall = **100.0% (2/2)**, Other strict recall = **0.0% (0/2)**. Overall Strict Recall = **50.0% (2/4)**, Overall Loose Recall = **100.0% (4/4)**.
      - Measured Tier 2 Perception on user `clip_001` misses ($t=11.50$s):
        - $t=11.50$s person (right): Tier 2 detected `vehicle(center)` (t=10.5s, 11.5s), dist=near, urg=3, latency=9672ms, retries=0/2 -> Strict: MISS, Loose: **HIT**
        - $t=11.50$s vehicle (right): Tier 2 detected `vehicle(center)` (t=10.5s, 11.5s), dist=mid, urg=2, latency=6481ms, retries=0/4 -> Strict: **HIT**, Loose: **HIT**
        - Summary: Vehicle strict recall = **100.0% (1/1)**, Person strict recall = **0.0% (0/1)**. Overall Strict Recall = **50.0% (1/2)**, Overall Loose Recall = **100.0% (2/2)**.
      - Inspected `clip_001` ($t=10.0$ to $14.0$ s): Confirmed vehicle (#6) and person (#5) at $t=11.20-11.60$ s were suppressed by Rule 1 (`trackedDuration < 0.80s` before alerting moving objects) and AGENTS.md Rule 8 (lateral divergence; objects moving further right away from heading).
    - **Tier 1 Fast-Closing Override & Evaluation Rerun**:
      - Implemented fast-closing override for moving classes (`vehicle`, `bicycle`, `person`):
        - If $h_{\text{frac}}$ grows by $\ge 0.15$ between consecutive samples (or closing speed / area growth $> 0.20$/s) AND $h_{\text{frac}} \ge 0.40$, alerts after 2 frames ($0.40$ s tracking) from ANY direction.
        - Uses caution wording only: `"Vehicle on right, careful"` / `"गाड़ी दाएँ, सावधान"` (Rule 8: no steering words for moving hazards; `clear_side: "none"`).
        - Retained $0.80$ s minimum tracking rule for slow-growth moving objects and $0.40$ s for static objects.
        - Exposed all parameters in `Tier1Config` and added interactive controls to `/#tier1` (`Tier1ReviewPage.tsx`).
        - Lateral-path suppression bypassed for fast-closing near vehicles.
      - Added unit tests in `apps/web/src/tier1/math.test.ts` covering fast-closing override, lateral suppression bypass, slow-growth tracking, and Hindi/English caution phrases (130/130 vitest passed).
      - Executed deterministic 0.40s offline evaluation on both user CSV-labeled clips (Node.js on CPU):
        - `clip_001.mp4`: Alerted at $t=11.60$s (`vehicle(right)`, $h=0.66$, $v=0.28$/s). User labeled miss `vehicle(right)` at $t=11.50$s is now **CAUGHT** ($t=11.60$s). False alert on `person(center)` at $t=1.20$s eliminated after enforcing that override requires at least 2 consecutive matched samples of the same track without intervening gaps ($dt \le 0.55$s) and growth $\ge 0.20$/s trigger. User miss `person(right)` at $t=11.50$s remains missed (only 1 frame detected, tracked $0.00$s). New alerts to judge: $t=11.60$s `vehicle(right)` (unlabeled).
        - `clip_006.mp4`: 0 alerts fired. User labeled misses at $t=6.28$s, $15.90$s, $18.11$s, $34.61$s remain missed by Tier 1 (stairs/other handled by Tier 2).
    - **Tier 1 Tracker Identity Gate & Review Page Diagnostics**:
      - Configurable gate thresholds in `Tier1Config` / `DEFAULT_TIER1_CONFIG`:
        - `identityMaxHeightRatio: 3.0` (reject match within 0.55s only if height ratio $> 3.0\times$)
        - `identityMaxAreaRatio: 9.0` (reject match within 0.55s only if area ratio $> 9.0\times$)
      - Displayed on `/#tier1` (`Tier1ReviewPage.tsx`) in both the Status & Telemetry HUD and interactive tuning sliders.
      - Preserves real fast-closing vehicles: in `clip_001` vehicle goes $h_{\text{frac}} = 0.333 \rightarrow 0.660$ ($1.98\times$) and area $0.0414 \rightarrow 0.1538$ ($3.7\times$) between $t=11.20$s and $11.60$s, safely below the $3.0\times$ and $9.0\times$ thresholds.
      - Rejects person identity switch ($5.19\times$ height shrinkage and $30.4\times$ area change) without falsely splitting fast-closing vehicles.
      - Added regression unit tests in `apps/web/src/tier1/math.test.ts`:
        - Real vehicle sequence at $t=11.20-11.60$s: track is kept (`consecutiveFrames: 2`) and `fast_closing_override` alert fires at $11.60$s.
        - Person identity switch at $t=0.0-1.2$s: match rejected ($5.19\times > 3.0\times$), new track created, no false override alert fires.
      - Diagnostics card on `/#tier1` (`Tier1ReviewPage.tsx`) displaying status badge, backend, load time, model URL, identity gate thresholds, error details, FPS and inference latency.
      - Live Browser Console & Runtime Errors panel intercepting `window.error`, `unhandledrejection`, `console.error`, and `detector.onError`.
      - Component tests in `apps/web/src/tier1/Tier1ReviewPage.test.tsx` verifying diagnostics, canvas bounding boxes, decision rows, unlabeled rows, and console errors panel.

  - **P4 Tier 2 Hardening, Rate Limiter, Spend Guard & Vision Recovery**:
    - **Circuit Breaker** (`server/circuit_breaker.py`):
      - 3 states: `CLOSED` (normal), `OPEN` (tripped after 3 consecutive Meta API failures), `HALF_OPEN` (probes single frame after 30 s cooldown)
      - Fails fast in OPEN state: returns degraded result with `Retry-After: 30`, avoiding hung requests and credit waste
      - Thread-safe transitions with monotonic clock
    - **Rate Limiter** (`server/rate_limiter.py`):
      - Sliding-window SQLite implementation in `eval/rate_limits.sqlite`
      - Per-device limits: burst 2 req / 1.0 s, sustained 60 req / 60.0 s
      - Global limits: burst 5 req / 1.0 s, sustained 120 req / 60.0 s
      - Bypassed for `/health`, `/status`, `/spend`, and during `FINAL_RUN=1`
      - Automatic prune on insert; persists across server restarts
    - **Spend Guard** (`server/config.py`, `server/meta_client.py`):
      - Throttle levels enforced per AGENTS.md:
        - `< $60`: normal (0.5 fps suggested interval 2000 ms)
        - `$60 - $90`: warn (logged, interval 2000 ms)
        - `$90 - $120`: throttle (0.33 fps, suggested interval 3000 ms)
        - `> $120`: block all dev calls; allows only `FINAL_RUN=1`
      - `GET /spend` returns spend, throttle level, call counts, suggested interval
    - **Hedged Wording** (`server/phrases.py`, `shared/phrases.json`):
      - Low-confidence detections (`0.0 < confidence < 0.6`): "possible" prefixed in English ("Possible stairs ahead"), "शायद" in Hindi ("शायद आगे सीढ़ियाँ")
      - Stop actions are never hedged: always authoritative ("Stop", "रुकें")
      - Preserved max 6 words constraint (Hard Rule 2)
    - **Server Integration** (`server/app.py`, `server/config.py`):
      - `/frame` endpoint: rate limiter check at start, spend guard, circuit breaker integration
      - Degraded result format: `status=degraded` with `reason` (`circuit_open|spend_blocked|rate_limited`)
    - **Fault Injection & Unit Tests**:
      - `test_fault_injection.py`: 14 tests covering 10 failure modes + circuit breaker state + FINAL_RUN bypass
      - `test_circuit_breaker.py`: 8 tests (open/close/half-open, success resets, concurrent safety)
      - `test_rate_limiter.py`: 10 tests (burst/sustained, persistence, prune, exempt endpoints)
      - `test_spend_guard.py`: 7 tests (levels, startup loading, restart survival, suggested_interval_ms)
      - `test_hedged_wording.py`: 9 tests (EN/HI hedging, Stop exception, phrase length, parse integration)
    - **Client Recovery & Arbiter Integration**:
      - `apps/web/src/client_network_failure.test.tsx`: 6 tests covering network failures, 429 handling, suggested interval, and no duplicate spoken alerts
      - `isRecovery` flag in `ArbiterMessage` and `recovery_interrupts_status` decision reason: recovery messages speak immediately, bypass dedupe/rate-limit, and interrupt any active P1 status
      - Queue sorting prioritizes recovery over hazards when both are P1
      - Recovery messages pass `clipKey: undefined, clipType: undefined` to skip audio manifest loading
      - Phrase table: `avoid_actions.none = { en: "stop", hi: "रुकें" }` for center static hazards
      - Rendered Vision Status event log on both MainApp and DemoPage under "Vision Status Events" heading with copy log button

    - **Verification & Documentation**:
      - Fixed server/circuit_breaker.py lazy lock initialization to prevent loop binding issues across async test cases.
      - Fixed server/tests/test_fault_injection.py rate limiter 429 assertion to be order-independent under concurrent asyncio.gather.
      - Full test suites verified: 154/154 passed in apps/web (Vitest), 74/74 passed in server/tests (pytest) — 228 total tests.
      - Production build in apps/web (tsc -b && vite build) passed with 0 errors.
      - Authored and committed README.md for GitHub submission strictly adhering to facts from AGENTS.md, PROGRESS.md, and code (architecture, priority arbiter, setup & run, measured CSV evaluation metrics, 228 test counts, and honest limitations).

- Next: P5 Navigation, P6 Emergency flow, profile & onboarding
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
