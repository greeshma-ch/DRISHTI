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
| Nov 01 | Tier 1 Stall Recovery & Decision Labeling | Automatic stall recovery (waiting/stalled/pause -> wait canplay -> play; abort 3 failed recoveries or 8s no progress); 320px capture downscaling; >854px warning with ffmpeg downscale command; decision row labeling buttons (True/False alert, Correct silence/Should have alerted), bulk "Mark all unlabeled as correct", "+ Mark Missed" hazard logging; live summary metrics (TP, FP, TN, FN, alerts/min, precision, recall) and CSV export |
| Nov 02 | Offline Eval Independence & Tier 2 Recall on Labeled Misses | Deterministic 0.4s sample stepper (playToNextSample, pause, detect, record, resume); gap-tolerant tracking up to 1.0s; sample spacing stats (min/med/max with >0.6s warning); check_clip_hazards.py --csv for labeled misses (±1.5s window); measured rerun of clip_001 and clip_006 |

## Current session

- Working on: Offline Eval Device-Speed Independence, Gap Tolerance & Tier 2 Labeled Misses Evaluation (COMPLETED)
- Done this session:
  - **Offline Evaluation Device-Speed Independence (Item 1)**:
    - Updated `eval_stepper.ts` and `Tier1ReviewPage.tsx` with deterministic step-and-pause offline evaluation: plays forward to next sample time via `playToNextSample(targetTime)`, pauses immediately, runs detector to completion, records result, and resumes.
    - Samples evaluated on an exact 0.4 s grid (`targetTime = 0.0, 0.4, 0.8, ...`) in `mediaTime`, completely decoupling offline eval from mobile/desktop processor speed.
    - Added sample spacing telemetry (`computeSampleSpacingStats`): calculates `min`, `median`, and `max` sample spacing in seconds across all steps.
    - Displayed spacing stats prominently on the review page HUD with an alert warning banner if `median > 0.6s`.
  - **Live Mode Gap Tolerance (Item 2)**:
    - Updated `updateTracker` in `apps/web/src/tier1/math.ts`:
      - Centroid distance and IoU matching thresholds now scale proportionally with sample gap: `gapScale = Math.max(1.0, gap / nominalInterval)` (`nominalInterval = 0.25s`).
      - Centroid distance threshold scales up to 0.65; IoU threshold scales down to 0.05.
      - Tracks persist across ~0.5s gaps (tested at 0.5s and 0.8s), preserving track ID, incrementing `consecutiveFrames`, and accumulating `trackedDuration`.
      - Maximum gap before track drop enforced at 1.0 s (`gap > 1.0s`).
  - **Tier 2 Perception Verification on Labeled Misses (Item 3)**:
    - Extended `scripts/check_clip_hazards.py` with `--csv <path>` argument to read exported labeled decision logs.
    - Filters rows marked as `missed_hazard` or `Should have alerted`, extracts frames at $t-1$, $t$, and $t+1$ s downscaled to 640 px wide with OpenCV, and calls `/frame` on each.
    - Evaluates semantic match within $\pm 1.5$ s window and formats table: `clip, t, expected, Tier 2 type & dir, dist, urg, latency, retries, hit/miss`.
    - Outputs Tier 2 recall summary table broken down by hazard type (`stairs`, `wall`, `person`, `vehicle`).
  - **Deterministic Clip Evaluation Rerun (Item 4)**:
    - Implemented `scripts/extract_frames.py` and `apps/web/src/tier1/run_clip_eval.ts` executing the exact same offline COCO-SSD `lite_mobilenet_v2` model, gap-tolerant tracker, and arbiter at exact 0.40s sample intervals.
    - Rerun `clip_001.mp4` (21.03s, 53 frames):
      - Sample spacing: min=0.40s, median=0.40s, max=0.40s (0.40s grid verified).
      - Total decisions logged: 16 (state changes only; no frame spam).
      - Total alerts: 0 (0.0 alerts/min).
      - True Alerts (TP): 0, False Alerts (FP): 0, Correct Silences (TN): 16, Missed Hazards (FN): 0.
      - Tracks cleanly accumulate duration across frames and transition to closing-speed checks (`closing_not_sustained`) instead of resetting at "tracked 0.00s".
      - Exported `eval/clip_001_decisions.csv` (16 rows).
    - Rerun `clip_006.mp4` (38.45s, 97 frames):
      - Sample spacing: min=0.40s, median=0.40s, max=0.40s (0.40s grid verified).
      - Total decisions logged: 4.
      - Total alerts: 0 (0.0 alerts/min).
      - True Alerts (TP): 0, False Alerts (FP): 0, Correct Silences (TN): 1, Missed Hazards (FN): 3.
      - Precision: N/A, Recall: 0.0% (static hazards outside COCO vocabulary).
      - Exported `eval/clip_006_decisions.csv` (4 rows).
    - Ran `python scripts/check_clip_hazards.py --csv eval/clip_006_decisions.csv` on the 3 labeled misses with Tier 2:
      - $t=14.80$s wall (center): Tier 2 detected `bag` ($t=13.8$s), `stairs` ($t=15.8$s) -> MISS
      - $t=21.20$s stairs (center): Tier 2 detected `stairs` ($t=20.2$s, $t=21.2$s), dist=near, urg=2, latency=1931ms, retries=0/4 -> **HIT**
      - $t=32.40$s wall (center): Tier 2 detected `none` (dark corridor) -> MISS
      - Tier 2 Recall on stairs: **100.0% (1/1 hit)**
      - Tier 2 Recall on wall: **0.0% (0/2 hit)**
      - Overall Tier 2 Recall on misses: **33.3% (1/3 hit)**
  - **Testing & Verification**:
    - `vitest run`: 126/126 passed across 8 test suites.
    - `tsc --noEmit`: 0 errors.
    - `eslint`: 0 errors.
    - `pytest server/tests`: 28 passed.
    - `ruff`: all checks passed.
    - `mypy`: 0 errors.
- Next: P4 Tier 2 hardening, rate limiter, spend guard.
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
