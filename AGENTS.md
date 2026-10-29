# AGENTS.md: Drishti

Shared instructions for every coding agent working in this repo (Claude Code, Antigravity, etc.).
Read this file and PROGRESS.md at the start of every session. Update PROGRESS.md before you stop.

## What this is

Drishti (working title) is a safety-first AI walking companion for blind and low-vision users.
A phone camera worn on a chest strap or lanyard (design is glasses-ready) feeds frames in; short
spoken guidance comes out. It warns about hazards with a direction, guides the user to a spoken
destination, speaks Hindi or English in the user's chosen tone, and can alert family in an emergency.

Built for the Meta Global AI Developer Hackathon (Indie track, theme: Build for Your World).
Judged on creativity, technical ambition, and whether it works. Deadline: Nov 4, 9 PM ET
(Nov 5, 7:30 AM IST). Internal freeze: Nov 4, 6 PM IST.

## Hard rules (never violate)

1. **Never claim a path or crossing is safe.** Report detections only ("vehicle approaching from
   the right") and remind the user to rely on their cane or guide dog.
2. **Urgent alerts are at most 6 words: action plus direction.** Example: "Pole ahead, step left."
3. **Fail loudly.** If vision is stale for more than 3 s, speak "Vision paused" at once and
   "Vision back" on recovery. Never go silent without saying so.
4. **No raw frame storage by default.** Do not log images. Eval clips live only in `eval/clips/`
   and are gitignored.
5. **Secrets only in `.env`.** Never commit keys. `.env.example` lists the variable names.
6. **All Meta API calls go through `server/meta_client.py`**, which records spend (see Budget guard).
   Never call the API directly from anywhere else.
7. **Use the Standard model tier for any real street footage.** The Contributor tier trains on
   prompts; use it only for non-personal test frames (empty rooms, no faces), if at all.

## Architecture

```
Phone camera -> Client (React/Vite PWA)
                  Tier 1: on-device moving-object detector (~200 ms)
                  frame sampler (JPEG, about 0.5 fps, up to 1 fps when walking or flagged)
                  GPS + compass, push-to-talk, TTS
             -> Server (FastAPI)
                  Tier 2: Muse Spark vision -> structured hazard JSON
                  SAM 3.1: walkable-corridor segmentation (left / center / right)
                  nav service: geocode -> foot route -> cue generator
                  profile service, emergency service (Telegram + tel:112 link)
             -> Priority arbiter (client) -> speech out
```

## Priority arbiter (the core idea)

Every utterance is a message `{priority, text, ttl_ms, key}`.

| Priority | Source | Behavior |
|---|---|---|
| P0 | Emergency | Interrupts everything; never queued |
| P1 | Imminent hazard (urgency 2 or 3) | Interrupts P2 and P3 mid-sentence |
| P2 | Navigation cue | Spoken at about 30 m and 10 m; held while a P1 is active |
| P3 | Advisory, answers, chat | Only when nothing above is active |

Rules: dedupe the same hazard type and direction for 4 s; at most one hazard utterance per 1.5 s;
drop any message past its TTL (hazard TTL 2 s); low-confidence detections use hedged wording
("possible step ahead").

## Perception contract (Tier 2 output)

```json
{
  "hazards": [{"type": "step_down|stairs|pothole|pole|vehicle|person|wire|open_drain|other",
               "direction": "left|center|right",
               "distance": "near|mid|far",
               "urgency": 0,
               "confidence": 0.0}],
  "path_clear": true,
  "instruction": "max 8 words, action plus direction",
  "signage_text": []
}
```

Use structured output and low reasoning effort. Parse defensively; on a parse failure, treat the frame
as unknown and do not speak a guess.

## Language and personalization

- Profile: `{name, language: hi|en, tone: calm|friendly|brisk, verbosity: terse|normal,
  units: steps|meters, mobility_aid: cane|guide_dog|none, contacts: []}`
- P1 hazard alerts and the emergency countdown use a **fixed phrase table** in `server/phrases.py`
  (English and Hindi), not free LLM text. Hindi phrases must be reviewed by a fluent speaker.
- P2/P3 free text comes from Muse Spark with a developer message built from the profile: simple
  spoken Hindi or English, short sentences, numbers written as words. Optional Hinglish mode.
- Voice commands in both languages: help / मदद, cancel / रुको, "take me to ..." / "मुझे ... ले चलो",
  be brief / संक्षेप में बोलो.

## Emergency flow

Trigger by voice ("help", "मदद"), triple-tap, or a large on-screen button. Speak a 10-second cancelable
countdown. On confirm: Telegram bot message to saved contacts with a map link, the time, and the last
3 alerts, plus a `tel:112` link (one-tap confirmed call; phones restrict silent auto-dial).

## Budget guard (hard cap: $150 in Meta Model API credits)

- `server/meta_client.py` wraps every call. After each response, read the `usage` fields and append
  `{ts, model, input_tokens, output_tokens, images, audio_seconds, est_cost_usd}` to
  `eval/spend.jsonl` (gitignored). Prices live in `server/prices.json`; verify them on Day 1.
- `GET /spend` returns total spend and the current throttle level.
- Throttle levels (total spend): under $60 normal; $60 to $90 warn in logs and PROGRESS.md;
  $90 to $120 throttle (Tier 2 at 0.33 fps, SAM every 8 s, live testing only on request);
  above $120 block all dev calls except calls made with `FINAL_RUN=1` (eval and demo recording).
  The last $30 is the reserve for final evaluation and the demo.
- Cost levers, in priority order: replay cached results for recorded clips (cache key = clip, frame
  index, model, prompt hash); frame-diff skip when the user is stationary or frames are near-identical;
  adaptive rate (0.5 fps normally, 1 fps when walking fast or Tier 1 flags something); keep the system
  prompt as a static prefix so cached-input pricing applies; downscale frames (test 512 px wide);
  minimal reasoning effort; SAM only on every 4th keyframe.
- Heavy iteration happens on recorded clips and stills, not live camera.

## Evaluation

About 20 first-person walking clips (30 to 45 s, daylight and dusk), labeled in `eval/labels.csv`:
`clip, t_start, t_end, type, direction`. `eval/run_eval.py` reports: hazard recall (alert before
contact), distance-to-hazard at alert time, false alarms per minute, direction accuracy, alert latency
p50 and p95, plus navigation route completion. Ablations: Tier 1 only vs Tier 2 only vs both; SAM
corridor on vs off; arbiter on vs speak-everything. Ablations reuse cached model outputs where possible.

## Stack and layout

```
drishti/
  apps/web/     React + Vite PWA (camera, Tier 1 detector, arbiter, TTS, push-to-talk)
  server/       FastAPI (meta_client.py, vision.py, nav.py, profile.py, emergency.py, phrases.py)
  eval/         clips/ (gitignored), labels.csv, run_eval.py, spend.jsonl (gitignored)
  AGENTS.md  PROGRESS.md  .env.example
```

Environment variables (names only): `MODEL_API_KEY`, `META_BASE_URL` (default
`https://api.meta.ai/v1`), `SPARK_MODEL` (check the Models page; currently muse-spark-1.3 or 1.2),
`SAM_MODEL` (sam-3.1), `TELEGRAM_BOT_TOKEN`, `FINAL_RUN`.

## Conventions

- Python 3.11+, type hints, small functions, `ruff` formatting. TypeScript strict mode on the web app.
- Model names, prices, and thresholds are config, never hard-coded in logic.
- Every new feature ships with a way to test it on a recorded clip or a unit test.
- Keep commits small. Log what changed and what is next in PROGRESS.md.

## Definition of done (per feature)

Works on the demo phone outdoors; respects the arbiter priorities; has a spoken failure mode; spend
is logged; documented in PROGRESS.md.

## Do not

- Add features outside the scope in PROGRESS.md without noting a trade-off.
- Add place recommendations, fall detection, or native glasses support unless PROGRESS.md says the
  core is stable (they are stretch or roadmap).
- Let free-form LLM text interrupt or replace a P1 hazard alert.
