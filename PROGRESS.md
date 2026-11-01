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

## Current session

- Working on: Tier 1 Slow-Phone Optimization, Verifiable Decision Logging, & Tier 2 Stairs Verification (COMPLETED)
- Done this session:
  - **Time-Based Tier 1 Rules for Low-FPS Phones (Item 1)**:
    - Replaced frame-count heuristics with time-based rules:
      - `minTrackDurationSec`: 0.8 s (moving objects must be tracked for >= 0.8 s).
      - `minClosingDurationSec`: 0.6 s (closing speed must be sustained for >= 0.6 s).
      - `staticMinTrackDurationSec`: 0.4 s debounce for static obstacles.
    - Verified at 2.5 FPS (400 ms frame intervals): an approaching vehicle from mid distance alerts at $t = 0.8$ s, well under the 1.5 s requirement.
  - **Comprehensive Decision Logging & CSV Export on `/#tier1` (Item 2)**:
    - Recorded every tracked object's evaluation decision per frame (`TrackDecisionLog`): `"alerted"` or `"suppressed: <rule>"`, with timestamp, class, direction, and detailed diagnostic reason.
    - Added interactive decision table on `/#tier1` with **True / False / Missed** ground-truth buttons per row.
    - Added **"Export CSV"** button exporting: `clip, t, class, direction, decision, reason, label`.
  - **Unified Live Clip Evaluation Pipeline (Item 3)**:
    - Removed any simplified/mock approximation paths for clip review.
    - Clip evaluation runs the exact production pipeline: Web Worker detector, IoU + centroid tracker, and live `PriorityArbiter`.
  - **Speed & Resolution Exploration (Item 4)**:
    - Added support for 192 px, 256 px, and 320 px input sizes in detector worker and review page controls.
    - Camera config set to 640x360 @ 15 fps (`frameRate: { ideal: 15, max: 15 }`).
    - Evaluated MediaPipe EfficientDet-Lite0 GPU delegate: ~32-38 ms latency and 4.4MB binary overhead vs tfjs lite_mobilenet_v2 (~14-18 ms @ 192px, ~20-25 ms @ 256px). As MediaPipe was not > 2x faster, tfjs was retained per specification.
    - Added guard skipping Tier 2 uploads while Tier 1 worker is busy (`tier1DetectorRef.current?.isBusy()`).
  - **Tier 2 Lens-Blocked Pause (Item 5)**:
    - Added guard pausing all Tier 2 cloud requests while lens is blocked (`isCameraBlockedRef.current`).
  - **Stairs Prompt Hardening & Verification Script (Item 6)**:
    - Explicitly mentioned *"stairs up or down, drop-offs, potholes, or obstacles"* in `server/meta_client.py` system and user prompts.
    - Created `scripts/check_clip_hazards.py` using OpenCV to sample 10 evenly spaced frames from any clip (or generate synthetic stairs test frames) and submit to `/frame`, outputting a clean summary table of detected hazards.
  - **Tests & Quality Verification**:
    - `vitest run`: 100 passing tests across 7 test files in `apps/web`.
    - `tsc --noEmit`: 0 errors.
    - `npm run lint`: 0 errors (31 acceptable test warnings).
    - `npm run build`: successful production build.
    - `pytest server/tests`: 25 passing tests in 0.96s.
    - `ruff check server`: 0 errors.
    - `mypy server`: 0 errors.
    - `ruff check scripts/check_clip_hazards.py`: 0 errors.
- Next: P4 Tier 2 hardening, rate limiter, spend guard.
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
