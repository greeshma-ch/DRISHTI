# Drishti — AI Walking Companion for Blind and Low-Vision Users

Drishti is a safety-first AI walking companion. A phone camera worn on a chest
strap or lanyard feeds frames in; short spoken guidance comes out. It warns
about hazards with a direction, guides the user to a spoken destination, speaks
Hindi or English in the user's chosen tone, and can alert family in an
emergency.

Built for the **Meta Global AI Developer Hackathon** (Indie track, theme:
*Build for Your World*).

> [!IMPORTANT]
> Drishti **complements** a cane or guide dog — it never replaces one.
> It reports detections ("Vehicle on right, careful") and never claims a path
> or crossing is safe.

---

## Two-Tier Design

```
Phone camera → Client (React / Vite PWA)
                 Tier 1: on-device COCO-SSD object detector (~200 ms)
                 frame sampler, GPS + compass, push-to-talk, TTS
            → Server (FastAPI)
                 Tier 2: Meta Llama (Muse Spark) vision → structured hazard JSON
                 nav service: geocode → foot route → spoken cue
                 profile service, emergency service (Telegram + tel:112)
            → Priority arbiter (client) → speech out
```

**Tier 1** runs a COCO-SSD `lite_mobilenet_v2` model entirely on-device in a
Web Worker (WebGL or WASM). It detects moving objects (vehicles, people,
bicycles, animals) and large static obstacles (chairs, benches, poles) and
tracks them frame-to-frame with IoU and centroid matching. When a tracked
object is closing fast — height fraction growing ≥ 0.15 between samples and
reaching ≥ 0.40 — an alert fires after just 0.40 s of tracking. Slower objects
require 0.80 s. A tracker identity gate (3.0× height, 9.0× area) rejects
spurious matches without breaking real fast-closing vehicles.

**Tier 2** sends downscaled JPEG frames to the Meta Model API at ~0.5 fps.
The cloud model returns structured JSON with hazard type, direction, distance,
urgency, and confidence for hazards that Tier 1 cannot detect: stairs, potholes,
open drains, step-downs, wires, construction, wall corners, and signage text.
A circuit breaker (3 failures → 30 s cooldown) and a spend guard
(\$60 warn / \$90 throttle / \$120 block) protect API credits. Low-confidence
detections (< 0.6) get hedged wording: "Possible stairs ahead" /
"शायद आगे सीढ़ियाँ".

---

## Priority Arbiter

Every utterance is a message `{priority, text, ttl_ms, key}`.

| Priority | Source | Behavior |
|---|---|---|
| P0 | Emergency | Interrupts everything; never queued |
| P1 | Imminent hazard (urgency 2–3) | Interrupts P2 and P3 mid-sentence |
| P2 | Navigation cue | Spoken at ~30 m and ~10 m; held while P1 is active |
| P3 | Advisory, answers, chat | Only when nothing above is active |

**Rules:** dedupe the same hazard type + direction for 4 s; at most one hazard
utterance per 1.5 s; drop any message past its TTL (hazard TTL 2 s). "Vision
back" recovery messages bypass dedupe and rate limits to speak immediately
after a degraded episode.

P1 hazard alerts and emergency phrases use a **fixed phrase table**
(`shared/phrases.json`) in English and Hindi — not free LLM text. Moving
hazards (vehicles, people, bicycles, animals) get caution wording only
("Vehicle on right, careful" / "गाड़ी दाएँ, सावधान"); lateral steering words
("step left") are reserved for static obstacles where the clear side is known.

---

## How to Run

### Prerequisites

- Node.js 18+ and npm
- Python 3.11+
- A Meta Model API key (set in `.env`)

### 1. Configure

```bash
cp .env.example .env
# Edit .env and add your MODEL_API_KEY
```

### 2. Start the server

```bash
PYTHONPATH=. uvicorn server.app:app --reload --host 0.0.0.0 --port 8000
```

### 3. Start the web app

```bash
npm install --prefix apps/web
npm run dev --prefix apps/web
```

The app serves at `http://localhost:5173`. On a phone, you need HTTPS for
camera access.

### 4. Tunnel to phone (HTTPS)

Use Cloudflare Tunnel or ngrok to expose `localhost:5173` over HTTPS:

```bash
cloudflared tunnel --url http://localhost:5173
# or
ngrok http 5173
```

Open the tunnel URL on the phone. Mount the phone on a chest strap or lanyard,
camera facing forward.

### Makefile shortcuts

```bash
make dev           # Start server + web in parallel
make test          # Run all tests (server + web)
make test-server   # pytest server/tests
make test-web      # vitest run in apps/web
make lint          # ruff + eslint + typecheck
```

---

## Measured Results

All numbers below come from human-labeled exported CSVs evaluated with the
deterministic 0.40 s offline stepper (Node.js CPU, COCO-SSD
`lite_mobilenet_v2`). Sample spacing verified at exactly 0.40 s (min, median,
max all 0.40 s).

### Tier 1 — clip_001 (21.03 s, 53 frames)

- **1 alert fired** at t=11.60 s: `vehicle(right)`, h_frac=0.66,
  closing speed 0.28/s, fast_closing_override rule.
- Human-labeled miss `vehicle(right)` at t=11.50 s → **caught** (alert at
  11.60 s, 0.10 s after label).
- Human-labeled miss `person(right)` at t=11.50 s → **not caught** (person
  detected for only 1 frame, tracked 0.00 s).

### Tier 1 — clip_006 (38.45 s, 97 frames)

- **0 alerts fired.** All 4 human-labeled misses (stairs at 18.11 s and
  34.61 s; other at 6.28 s and 15.90 s) are outside COCO-SSD's vocabulary.
  These are Tier 2 hazards.

### Tier 2 Perception on clip_006 Labeled Misses (via server `/frame`)

| Time (s) | Expected | Tier 2 Detected | Latency | Strict Hit | Loose Hit |
|---|---|---|---|---|---|
| 6.28 | other (center) | stairs (center) | 7440 ms | ✗ | ✓ |
| 15.90 | other (right) | stairs (center) | 4274 ms | ✗ | ✓ |
| 18.11 | stairs (center) | stairs (center) | 3129 ms | ✓ | ✓ |
| 34.61 | stairs (center) | stairs (center) | 4729 ms | ✓ | ✓ |

- Stairs strict recall: **100% (2/2)**. Other strict recall: **0% (0/2)**.
- Overall strict recall: **50% (2/4)**. Overall loose recall: **100% (4/4)**.

### Tier 2 Perception on clip_001 Labeled Misses

| Time (s) | Expected | Tier 2 Detected | Latency | Strict Hit | Loose Hit |
|---|---|---|---|---|---|
| 11.50 | person (right) | vehicle (center) | 9672 ms | ✗ | ✓ |
| 11.50 | vehicle (right) | vehicle (center) | 6481 ms | ✓ | ✓ |

- Vehicle strict recall: **100% (1/1)**. Person strict recall: **0% (0/1)**.
- Overall strict recall: **50% (1/2)**. Overall loose recall: **100% (2/2)**.

---

## Tests

**228 tests across 21 test files**, all passing.

### Web app (Vitest) — 154 tests in 14 files

| Test file | Tests | What it covers |
|---|:---:|---|
| `math.test.ts` | 41 | Tracker, fast-closing override, identity gate, gap tolerance, caution phrases |
| `eval_stepper.test.ts` | 23 | Deterministic 0.40 s offline evaluation stepper |
| `Tier1ReviewPage.test.tsx` | 3 | Telemetry HUD, canvas bounding boxes, unlabeled rows, console errors |
| `arbiter.test.ts` | 43 | P0–P3 priorities, dedupe, TTL, recovery preemption |
| `arbiter.property.test.ts` | 9 | Property-based invariant fuzzing |
| `arbiter.stateful.test.ts` | 6 | Stateful sequence checks |
| `client_network_failure.test.tsx` | 9 | Network failure backoff, 429 retry, "Vision back" |
| `DemoPage.integration.test.tsx` | 9 | P1 interrupting P3, audio cleanup |
| `recovery_policy.test.ts` | 2 | Hazard-before-recovery ordering |
| `vision_recovery.test.tsx` | 1 | Vision status event log UI |
| `debug_exact.test.ts` | 1 | Recovery ordering edge case |
| `debug_recovery.test.ts` | 1 | Hazard + status concurrency |
| `App.test.tsx` | 5 | App controls, debug overlay, stale threshold |
| `smoke.test.ts` | 1 | Environment smoke test |

### Server (pytest) — 74 tests in 7 files

| Test file | Tests | What it covers |
|---|:---:|---|
| `test_circuit_breaker.py` | 8 | 3 failures → OPEN, 30 s cooldown → HALF_OPEN, concurrency |
| `test_rate_limiter.py` | 10 | Burst/sustained sliding-window, SQLite persistence, 429 headers |
| `test_spend_guard.py` | 7 | \$60/\$90/\$120 levels, FINAL_RUN bypass, suggested intervals |
| `test_fault_injection.py` | 14 | 10 failure modes, circuit breaker state, FINAL_RUN |
| `test_frame.py` | 21 | Defensive parser, retry on truncation, phrase generation |
| `test_hedged_wording.py` | 9 | Low-confidence hedging, Stop exception, max 4 words |
| `test_app.py` | 5 | Health and spend endpoints |

---

## Honest Limits

- **Tier 1 runs at about 2.5 FPS on a mid-range phone.** Desktop is faster,
  but the target device is a phone worn on the chest. Detection latency and
  alert timing are measured on Node.js CPU and may differ on mobile WebGL.

- **Stairs and wall corners rely on the slower cloud model.** COCO-SSD has no
  class for stairs, potholes, open drains, or walls. These hazards can only be
  detected by Tier 2 (Meta Llama Muse Spark), which has a median latency of
  3–5 s per frame. If the server is unreachable, these hazards are missed.

- **Works in the foreground only.** The PWA must stay in the foreground for the
  camera and TTS to work. There is no background service or native app.

- **Telegram alerts are experimental and not verified end to end.** The
  emergency flow sends a Telegram bot message to saved contacts, but the
  integration has not been tested in a live emergency scenario.

- **The emergency flow is a countdown, then a prefilled SMS and a 112 link
  that need a tap.** The app cannot silently auto-dial; phones restrict this.
  The user must tap the link to confirm the call.

- **"Vision back" announcements are unreliable.** When the arbiter has a P1
  hazard and a recovery message in the same frame, the hazard takes priority.
  "Vision back" may be delayed or, in edge cases, not spoken.

- **Nearby places use OpenStreetMap data that may be incomplete.** Coverage
  varies by region. Some areas may have missing or outdated POI data.

- **It complements a cane or guide dog.** Drishti is an assistive overlay,
  not a replacement for established mobility aids. It reports detections and
  never claims a path is safe.

---

## Project Layout

```
drishti/
  apps/web/         React + Vite PWA (camera, Tier 1, arbiter, TTS)
  server/           FastAPI (meta_client, vision, phrases, circuit breaker,
                    rate limiter, spend guard)
  shared/           phrases.json (EN + HI phrase table)
  eval/             clips/ (gitignored), labels.csv, run_eval.py
  scripts/          check_clip_hazards.py, extract_frames.py
  AGENTS.md         Agent instructions and hard rules
  PROGRESS.md       Handoff log with measured results
  .env.example      Environment variable names
```

## License

Built for the Meta Global AI Developer Hackathon.
