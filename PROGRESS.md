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
| Oct 29 (today) | Setup, P0, P1, P2 | Bootstrap, walking skeleton (camera -> server -> Meta -> speech), arbiter v1 & phrase table | [x] P0 done |
| Oct 30 | P3, P4 | Tier 1 on-device detector, Tier 2 hardening, rate limiter, spend guard | [ ] |
| Oct 31 | P5, P6, P5b | Navigation, emergency flow, profile & onboarding, "what's nearby" | [ ] |
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
| | | | | |

## Decision log

| Date | Decision | Why |
|---|---|---|
| Oct 26 | Phone-first on a chest strap or lanyard; glasses-ready design, no native glasses app | No glasses available |
| Oct 26 | Demo languages: Hindi and English | Chosen by builder |
| Oct 26 | Urgent alerts use a fixed phrase table, not free LLM text | Latency, predictability, Hindi grammar control |
| Oct 26 | Tier 2 at about 0.5 fps by default, adaptive up to 1 fps | Credit cap |

## Current session

- Working on: P0 Repo bootstrap
- Done this session:
  - Repository structure created: apps/web, server, eval, shared
  - Server: /health and /spend endpoints, pydantic-settings reading .env, pytest, ruff, mypy passing
  - Web: React 19 + Vite + TypeScript strict, vitest, fast-check, eslint passing, placeholder UI
  - shared/phrases.json, .env.example, .gitignore, Makefile, GitHub Actions CI, README.md
- Next: P1 Walking skeleton (camera to server to Meta to speech)
- Blockers: None

## Open issues and risks

- Meta API reachability from India (fallback: OpenRouter for Spark; open-weights SAM via Modal or Baseten)
- SAM latency (fallback: every 3rd to 5th keyframe, or Spark-only Tier 2)
- Hindi voice or speech recognition quality (fallback: alternate voice, cloud TTS, or Hindi captions)
- 0.5 fps Tier 2 means static hazards may be reported late; report distance-to-hazard at alert time in the eval
- False alarms (fallback: higher thresholds, two-frame agreement; report the trade-off honestly)
