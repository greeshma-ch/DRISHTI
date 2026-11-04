# BUILD_PROMPTS.md: Drishti

Copy-paste prompts for Claude Code or Antigravity, in order. Rescheduled on Oct 29 (IST) after three days were lost,
so this schedule **supersedes the day plan in PROGRESS.md**. Assumed test device: Android phone, Chrome.
If you use an iPhone, tell the agent in Prompt 5 (compass permission) and Prompt 9 (no vibration).

## Setup before P0 (60 to 90 minutes, do it in this order)

**1. Keys and accounts**
- [ ] Meta Model API key in a local `.env` (never in a prompt or a commit). Make one curl call with a text prompt and one with an image, and note latency and token counts.
- [ ] Telegram: create a bot with @BotFather, save the token, send the bot a message from a test contact, and fetch the chat id from the `getUpdates` endpoint.
- [ ] A private GitHub repo.

**2. Tools on your laptop**
- [ ] Node 20 or newer, Python 3.11 or newer, git, and `uv` or `venv`.
- [ ] `cloudflared` (Cloudflare Tunnel) or ngrok, so the phone can open your dev server over HTTPS. Phones refuse camera access on plain HTTP.
- [ ] Claude Code installed and logged in; Antigravity installed. Check your usage window before starting a long Claude Code session.

**3. The repo, before any agent touches it**
- [ ] Put `AGENTS.md`, `PROGRESS.md` and `BUILD_PROMPTS.md` at the repo root.
- [ ] Add a `CLAUDE.md` containing one line: `Read and follow @AGENTS.md and PROGRESS.md.` If Antigravity does not load `AGENTS.md` on its own, the prompts already tell it to read the file.
- [ ] Create `.gitignore` with `.env`, `eval/clips`, `eval/spend.jsonl` **before the first commit**, then commit.
- [ ] Work on a branch per prompt (`p1-skeleton`, `p2-arbiter`, and so on) and merge only when the tests pass.

**4. The phone (Android, Chrome)**
- [ ] Turn on Developer options and USB debugging, then open `chrome://inspect` on the laptop so you can read the phone's console and `speechSynthesis.getVoices()`.
- [ ] Install the Hindi voice data for Google text-to-speech and add Hindi to the keyboard and voice input languages.
- [ ] Grant camera, microphone and location to Chrome; turn off battery saver and keep the screen awake while testing.
- [ ] A chest strap or lanyard mount, plus one earbud (so you can still hear traffic when testing outdoors).

**5. Filming kit (for the P7 eval)**
- [ ] Record in landscape at 720p, phone at chest height, 30 to 45 seconds per clip.
- [ ] Naming: `clip_001_day_street.mp4`. Save to `eval/clips/` (gitignored).
- [ ] Create `eval/labels.csv` with the header `clip,t_start,t_end,type,direction` and label each clip the same evening.
- [ ] Film 2 to 3 clips today if there is light; the rest tomorrow in daylight and at dusk.

**6. Config decisions to fix now (so agents do not guess)**
- [ ] Default language `hi`, with `en` as fallback.
- [ ] `SPARK_MODEL` and `SAM_MODEL` set from the Models page (the exact IDs change).
- [ ] `server/prices.json` filled from the pricing page, then corrected after your first real call.
- [ ] Step length 0.7 m unless you measure your own.

**Ready to start P0 when:** the Meta curl works from your machine, the tunnel opens a page on your phone, the repo has the three markdown files and a safe `.gitignore`, and both agents can open the repo.


## How to run each prompt

1. New agent session per prompt. Begin with: "Read AGENTS.md and PROGRESS.md first."
2. Ask the agent to **plan first**: "Show me your plan and the files you will touch. Wait for my OK."
3. Let it implement, run the tests, and fix failures. Do not accept "should work"; ask for test output.
4. Test on the real phone (HTTPS tunnel). Use the phone check listed at the end of each prompt.
5. Commit, then have the agent update PROGRESS.md (done, next, blockers, spend).
6. If a prompt grows beyond one session, split it. Do not let the agent add features that are not listed.

## Compressed schedule (IST), restarted Oct 29

| Date | Prompts | Gate |
|---|---|---|
| Oct 29 (today) | Setup, P0, P1, P2 | Phone sends a frame, server calls Meta, phone speaks a Hindi sentence; arbiter tests pass. If setup eats the morning, P2 may slip into the first hour of Oct 30 |
| Oct 30 | P3, P4 | Tier 1 alerts and Tier 2 hazards both reach the arbiter; failures are spoken. Film clips in daylight between sessions |
| Oct 31 | P5, P6, then P5b if P5 and P6 are done by about 4 PM | Simulated route gives correct cues; emergency flow works end to end; "what's nearby" speaks real places |
| Nov 1 | P7 | First eval numbers. **Gate: walk to a destination outdoors with live alerts.** Decide whether the SAM corridor stays |
| Nov 2 | P8 in the morning; P9a in the afternoon **only if the Nov 1 gate passed** | Fault-injection matrix passes; offline mode works; 30-minute soak test; memory and history retrieve correctly |
| Nov 3 | P9-lite, freeze | Accessible UI and saved places only; feature freeze by evening; film demo footage |
| Nov 4 | Demo edit, README, architecture diagram, submit | Submit by 6:00 PM IST (official deadline Nov 5, 7:30 AM IST) |

**Daily rule:** if a gate is missed, drop the next item from the cut list instead of moving the schedule.

**Highlight features (what's nearby, history, semantic search) are in, behind feature flags, with hard rules:**
they feed P3 only, they never delay or replace a hazard alert, and any failure falls back silently to stateless
behavior. Memory (P9a) runs only if the Nov 1 gate passes (a real outdoor walk with live alerts). Time-box: P5b 3 hours, P9a 4 hours.

**Cut list, in order:** embeddings (fall back to keyword search), conversation history, "what's nearby", the SAM corridor
(decide on Nov 1), UI polish beyond accessibility basics. Never cut the arbiter, the eval, the fault-injection tests,
or the spoken failure modes.

---

## P0: Repo bootstrap

**Tool:** Antigravity (Gemini 3.8 Flash). Scaffolding is fast and low risk.

```
Read AGENTS.md and PROGRESS.md first. Then set up the repository.

Create the layout from AGENTS.md: apps/web (React + Vite + TypeScript strict), server (FastAPI, Python
3.11), eval, shared. Add:
- server: /health and /spend endpoints, pydantic settings reading .env, ruff, mypy, pytest.
- web: eslint, vitest, fast-check, a placeholder page.
- shared/phrases.json (empty structure for en and hi) that both web and server can read.
- .env.example with MODEL_API_KEY, META_BASE_URL, SPARK_MODEL, SAM_MODEL, TELEGRAM_BOT_TOKEN, FINAL_RUN.
- .gitignore covering .env, eval/clips, eval/spend.jsonl, node_modules, __pycache__.
- A Makefile with: make dev (server and web), make test, make lint, make tunnel (prints the command to run a
  Cloudflare Tunnel or ngrok so the phone can open the dev server over HTTPS).
- GitHub Actions CI that runs lint, typecheck and tests for both apps.
- README with run instructions.
Also update the day plan in PROGRESS.md to match BUILD_PROMPTS.md.

Acceptance: make test passes locally and in CI; the placeholder page opens on my phone through the tunnel.
Do not add any feature code yet.
```

Phone check: open the tunnel URL on the phone and see the page.

## P1: Walking skeleton (camera to server to Meta to speech)

**Tool:** Antigravity (Flash). Switch to Claude Code (Fable) if the Meta API call or schema parsing keeps failing.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Build the thinnest end-to-end path.
Client: open the rear camera with getUserMedia, capture a 640x360 JPEG every 2 seconds, POST it (multipart)
to /frame with a timestamp and a user language. Show a debug overlay: last latency, tokens, estimated cost,
and the last spoken text.
Server: server/meta_client.py wraps every Meta API call (OpenAI-compatible, base URL and model names from env).
It must read the usage fields from each response and append a record to eval/spend.jsonl using prices in
server/prices.json. /frame calls Muse Spark with the image and the perception JSON schema from AGENTS.md
(structured output, low reasoning effort, static system prompt as prefix) and returns the parsed hazard JSON.
Parse defensively: on any parse failure return an "unknown" result and never a guess.
Client then speaks the instruction with speechSynthesis (hi-IN or en-IN voice, picked by language).
Drop any frame result older than 3 seconds. Do not store frames anywhere.

Acceptance: pointing the phone at a chair, a person and a door produces a spoken sentence each time;
the overlay shows latency and real token counts; spend.jsonl is written; pytest covers the parse-failure path.
```

Phone check: record the real token count for a 640x360 frame and tell me. We recompute the budget from it.

## P2: Priority arbiter and phrase table

**Tool:** Claude Code (Fable). Safety-critical logic. **Review:** ask Antigravity (Flash) to write extra edge-case tests and try to break it.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Implement the priority arbiter as a pure TypeScript module (apps/web/src/arbiter.ts) with no DOM
dependency. The speech engine is injected as an interface {speak(text, lang), cancel()} so it can be tested.
Messages: {priority 0-3, text, ttlMs, key, lang}. Rules from AGENTS.md: P0 interrupts everything; P1
interrupts P2 and P3 mid-sentence; P2 is held while a P1 is active; P3 speaks only when idle; dedupe the same
key for 4 seconds; at most one hazard utterance per 1.5 seconds; drop expired messages; a watchdog that
speaks "Vision paused" if no vision result arrives for 3 seconds and "Vision back" on recovery.
Fill shared/phrases.json (en and hi) with phrases for: pole, vehicle, person, step down, stairs, pothole,
wire, open drain, each with left/center/right, plus vision paused/back, offline mode, emergency countdown,
cancelled, sent. Use the table from the spec doc as the starting point. Keep urgent phrases at 6 words or fewer.
Add a /demo page with buttons that fire a message of each priority so I can hear interruptions in Hindi.
Use fast-check property tests: a P1 is never delayed by a P3; speech never overlaps; expired messages never
speak; dedupe and rate limit hold under random message streams.
Client-side watchdog: count fetch failures and timeouts on the client, not the server. After 2 consecutive
failures, or 4 s with no response, speak "Vision limited"; repeat every 15 s while it lasts; speak "Vision back"
on recovery. Use the pre-rendered audio clips for these phrases so they work offline. Prefer voices with
localService true, and never rely on a network voice for a safety phrase.

Acceptance: all tests pass; on the phone, firing P3 then P1 cuts the P3 mid-sentence.
```

Phone check: listen to every Hindi phrase and mark the ones that sound wrong. Get a fluent speaker to review them.

## P3: Tier 1 on-device detector

**Tool:** Antigravity (Flash). **Review:** have Claude Code (Fable) check the direction and closing-speed math and tests.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Add the on-device Tier 1 detector. Use TensorFlow.js COCO-SSD (or onnxruntime-web with YOLOv8n if you can justify
it) inside a Web Worker. Cap the frame rate adaptively (target 5 to 10 fps, lower on a slow phone).
- Classes: person, bicycle, car, motorcycle, bus, truck, dog, cow, chair, bench, couch, dining table, potted
  plant, fire hydrant, suitcase. Map COCO names to our hazard enum (chair, table, bench, vehicle, bicycle,
  person, animal, other).
- Direction: left, center or right third by bounding-box center.
- Proximity: bounding-box height as a fraction of the frame, classified near, mid or far with thresholds in a
  config file.
- Closing speed: smoothed growth of bounding-box area over the last 3 frames.
- Emit hazard events {type, direction, distance, urgency 1-3} into the existing arbiter, using phrases from
  shared/phrases.json. Use the same dedupe key (type + direction) as Tier 2, so a hazard already announced by
  Tier 1 is not repeated by Tier 2 within 4 s.
- Show detector FPS and per-frame latency in the debug overlay. If the model fails to load, speak the
  detector-unavailable message and continue without Tier 1.
- Add a /#tier1 page with a file picker: I choose a video clip from my phone or laptop, it plays with bounding
  boxes and the alerts that would fire, so I can test on real footage.
- Standing still facing a static far-away object must produce no alerts.
Tests: fixtures for direction, proximity and closing-speed math, and the shared-key dedupe with Tier 2.
Acceptance: walking toward a person or chair triggers an alert in under 300 ms in the logs.
```

Phone check: stand still facing traffic and confirm there are no false alarms; then walk toward a parked vehicle.

## P4: Tier 2 hardening, circuit breaker, rate limiter, spend guard

**Tool:** Claude Code (Fable). **Review:** ask Antigravity (Flash) to read the fault-injection tests and list failure cases that are missing.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Harden the server path.
1. vision.py: final Tier 2 prompt (static prefix first), confidence thresholds, hedged wording for low
   confidence, schema validation. Add the SAM 3.1 corridor behind a feature flag: check the Meta docs for
   the request format, run it on every 4th keyframe, compute free walkable share for left, center, right.
2. Circuit breaker around Meta calls: 3 second timeout; 3 consecutive failures open it for 30 seconds; while
   open, /frame returns a degraded result the client announces as "vision limited" and Tier 1 continues.
3. Token-bucket rate limiter per user per endpoint, persisted in SQLite: frames about 1.2/s with burst 3,
   chat 10/min, geocoding 1/s global. Return 429 with Retry-After; the client lowers its frame rate and
   announces it. Emergency endpoints are never limited.
4. Spend guard from AGENTS.md: GET /spend, throttle levels at $60, $90 and $120, FINAL_RUN override.
5. Replay cache keyed by (clip id, frame index, model, prompt hash) so eval runs reuse results.
6. Adaptive client frame rate: 0.5 fps normally, 1 fps when GPS speed shows walking fast or Tier 1 flags a hazard.
Write fault-injection tests for: Meta 500, timeout, 429, malformed JSON, offline server. Each must end in an
expected spoken message.

Acceptance: the fault-injection tests pass; a scripted run shows the breaker opening and closing; spend is correct.
```

Phone check: turn on airplane mode mid-walk and confirm you hear the offline message and Tier 1 keeps working.

## P5: Navigation

**Tool:** Claude Code (Fable) for the cue and bearing logic; Antigravity (Flash) is fine for the client geolocation and compass wiring.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Implement navigation. server/nav.py: geocode with Nominatim (custom User-Agent, 1 request per second,
cache results), foot route from OSRM (base URL in env, so it can be swapped). Cue generator: distances in
steps by default (0.7 m per step, configurable), cues at about 30 m and 10 m before each turn, arrival cue,
off-route detection beyond 20 m with automatic re-route.
Client: geolocation watch plus DeviceOrientation compass with a low-pass filter; handle the iOS permission
prompt if present. Compare route bearing with heading to say turn left or right. Cues enter the arbiter as P2
so a P1 hazard holds them. Add a simulation mode that replays a recorded GPS and heading JSON so I can test
without walking. Voice flow: "take me to X" / "मुझे X ले चलो" gets a destination, confirms it aloud, then starts.
Unit tests with fixtures for bearing math, cue generation and off-route logic.

Acceptance: a simulated route gives correct cues in Hindi and English; a hazard during a cue holds the cue.
```

Phone check: walk one real 300 m route and note where GPS or compass misleads you.

## P5b: What's nearby (highlight feature)

**Tool:** Claude Code (Fable) for the geometry and the no-invention tests; Antigravity (Flash) for the client voice wiring.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Add a "what's nearby" feature behind a NEARBY_ENABLED flag. server/nearby.py: given lat, lon and a radius
(default 300 m), query OpenStreetMap Overpass for pharmacy, hospital, clinic, atm, bank, toilets, bus stop,
restaurant and shop. Use a configurable endpoint, a 4 second timeout, and cache results by a roughly 50 m grid
for 10 minutes; respect the Overpass usage policy. Compute distance and bearing from the user's position and
heading to each place and convert to steps plus left, ahead or right.
Muse Spark turns the top 5 places into two short spoken sentences in the user's language, tone and verbosity
(static prompt prefix, minimal reasoning). It must mention only places returned by Overpass and never invent one.
Voice: "what's nearby" / "आसपास क्या है", and "nearest pharmacy" / "सबसे पास की दवा की दुकान", followed by an offer to
navigate there using the P5 flow. Output enters the arbiter as P3 only. If Overpass or Meta fails, say
"I can't look up places right now" and nothing else.
Tests: distance, bearing and steps fixtures; a no-invention test (the answer uses only returned places); the
timeout path; the arbiter holds nearby speech while a hazard is active.

Acceptance: on the phone, asking in Hindi and in English names real places with step counts and directions.
```

Phone check: before building, open openstreetmap.org around your demo route. OpenStreetMap coverage can be thin in smaller towns,
so pick a demo area where the places actually exist on the map.

## P6: Emergency flow, profile and onboarding

**Tool:** Claude Code (Fable). A bug here can hurt a user. **Review:** have a second tool read the emergency tests before you trust them.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

1. Device-bound anonymous user: the server issues a user id and token on first launch, stored in IndexedDB.
   Add a spoken recovery code. No email or password.
2. Profile stored locally first (IndexedDB) and synced to the server: language hi|en, tone calm|friendly|brisk,
   verbosity terse|normal, units steps|meters, mobility_aid, contacts. A sighted helper enters contacts on a
   setup screen. Add a 30-second voice onboarding for language, tone and verbosity, and live commands like
   "be brief" and "speak Hindi".
3. Emergency flow: triggers are the voice words help / मदद, a triple-tap, and a large button. Speak a
   10-second cancelable countdown; cancel with "cancel" / "रुको" or a tap. On confirm: the server sends a
   Telegram message and location to saved contacts with the last 3 alerts (no frames), and the client shows a
   one-tap tel:112 link. If the server is unreachable, fall back to a prefilled sms: link for the first
   contact and still offer tel:112. Emergency is P0 and never rate-limited.
4. Voice command: "delete my data" / "मेरा डेटा मिटाओ" wipes local and server data after a spoken confirmation.
Tests: countdown timing, cancel, offline fallback, profile persistence across reload.
5. Do not edit the rate limiter or the Meta client. Keep emergency code in new files (server/emergency.py, apps/web/src/emergency.ts) and touch App.tsx only to mount it.
6. /emergency/* routes are exempt from rate limiting (P4 adds the limiter in another session).

Acceptance: the full emergency flow works end to end on the phone with a test contact.
```

Phone check: trigger a false alarm on purpose and cancel it by voice and by tap.

## P7: Evaluation harness

**Tool:** Claude Code (Fable) for the metrics and replay logic; Antigravity (Flash) for the results-table UI.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Build the eval as a /eval page in the web app so Tier 1, the arbiter and the UI code run in one runtime.
It loads a clip (video file) and its rows from eval/labels.csv (clip, t_start, t_end, type, direction), steps
through frames at the production rates, runs Tier 1 live, calls the server /frame for Tier 2 using the replay
cache, passes everything through the real arbiter, and records alert times. Compute: hazard recall (alert before
contact), distance-to-hazard at alert time (use labeled contact time and walking speed as a proxy and say so),
false alarms per minute, direction accuracy, alert latency p50 and p95. Add ablation toggles: Tier 1 only,
Tier 2 only, both; SAM corridor on or off; arbiter on or speak-everything. Export a JSON and CSV report and
render a results table I can screenshot. Add a script to bulk-run all clips.

Acceptance: running 3 sample clips produces a report; a second run costs no API calls thanks to the cache.
```

Phone check: film clips in daylight and at dusk with the phone mounted at chest height and label them the same evening.

## P8: Reliability hardening

**Tool:** Split. Claude Code (Fable) for the fault-injection matrix, error handling and soak test; Antigravity (Flash) for the service worker (Workbox) and the Playwright smoke test.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Make failures safe and spoken.
- Service worker (Workbox): cache the app shell and the Tier 1 model so the app opens and Tier 1 works offline.
- Screen Wake Lock while navigating; announce if the app goes to the background or the screen locks.
- Spoken flows for denied camera, microphone and location permissions, and for lost GPS.
- Online and offline detection: speak "Offline mode: moving-object alerts only" and "Back online".
- A global error boundary and a window error handler that speak a short failure message, plus a local log ring
  buffer and a /status page (breaker state, spend, FPS, last errors).
- A Playwright smoke test (page loads, permissions mocked, one frame round trip with a mocked server).
- A fault-injection matrix document and test: API 500, timeout, 429, malformed JSON, offline, database down,
  GPS lost, camera denied, microphone denied. Each row names the expected spoken message and passes.
- A 30-minute soak test script logging memory, FPS, battery and detector latency every minute.
Acceptance: every row of the matrix passes; the soak test shows no memory growth trend or FPS collapse.
```

Phone check: run the soak test with the screen locked and unlocked and note what happens.

## P9: UI, accessibility, and memory-lite

**Tool:** Antigravity (Flash) with its browser testing for the UI. **Review:** Claude Code (Fable) checks the accessibility semantics and the privacy and deletion behavior of memory-lite.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Polish for blind and low-vision users.
- One large full-width push-to-talk control; large labeled buttons; a high-contrast, large-text theme with
  a toggle; no custom gestures that conflict with TalkBack.
- aria-live regions for status, real labels everywhere, a logical focus order, and a settings screen.
- Vibration patterns for hazard and emergency on Android; do not rely on them.
- Memory-lite in SQLite: saved places only ("home", "pharmacy"), so "take me to home" resolves to a place. Store
  text only, never frames. It feeds P2 and P3 answers only and never touches hazard alerts. Add the spoken
  "delete my data" command. History and semantic search are P9a.
- axe-core accessibility tests and a manual TalkBack checklist.
Acceptance: axe tests pass; the whole demo flow works with my eyes closed.
```

Phone check: run the full flow with TalkBack on and the screen turned away.


## P9a: Memory, history and semantic search (highlight feature, only if the Nov 1 gate passed)

**Tool:** Claude Code (Fable) for retrieval, privacy and deletion; **Review:** Antigravity (Flash) tries to break per-user isolation and the delete command.

```
Read AGENTS.md and PROGRESS.md first. Plan first and wait for my OK.

Add memory behind a MEMORY_ENABLED flag. SQLite tables: saved_places (name, lat, lon, aliases), turns (id,
user_id, ts, language, role, text, embedding BLOB nullable), destinations (name, lat, lon, ts). Store text only,
never frames, keyed per user id, with a configurable retention (default 30 days).
Search: SQLite FTS5 keyword search first. Then local multilingual embeddings (sentence-transformers
multilingual-e5-small, or an ONNX equivalent if server RAM is tight; Hindi and English must both work) with
brute-force cosine over the user's own turns and places, and hybrid ranking (FTS score plus cosine). Embed in a
background task so it never blocks a request; if the model cannot load, fall back to FTS5 only and keep working.
Uses: "take me to the pharmacy I asked about yesterday", "वही जगह जहाँ कल गए थे", "what did I ask about earlier".
For a fuzzy match, confirm aloud before navigating: "Do you mean X, about 400 steps away? Say yes."
Memory feeds P2 and P3 only and never touches hazard alerts. "Delete my data" / "मेरा डेटा मिटाओ" wipes everything
after a spoken confirmation.
Tests: Hindi and English retrieval fixtures with expected top results; FTS fallback when embeddings are
unavailable; deletion; per-user isolation; no frames or GPS tracks stored beyond saved destinations; the server
still answers when the memory database is down.

Acceptance: on the phone, asking about an earlier place in Hindi resolves to the right place and navigation starts only after you say yes.
```

Phone check: measure server RAM with the embedding model loaded, because an always-on small instance may not fit it.

---

## When something goes wrong

- Paste the exact error and the failing test output, not a description.
- Ask the agent to write a failing test first, then fix.
- If an agent suggests a bigger refactor, ask for the smallest change that fixes the failure.
- Keep PROGRESS.md current; it is how the next session recovers context.
