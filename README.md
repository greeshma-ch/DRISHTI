# Drishti

AI walking companion for blind and low-vision users. A phone camera worn on a chest strap feeds frames in; short spoken guidance comes out.

Built for the Meta Global AI Developer Hackathon (Indie track).

## Quick start

### Prerequisites

- Node 20+, Python 3.11+, git
- `cloudflared` or `ngrok` for HTTPS tunnel to phone

### Setup

```bash
cp .env.example .env
# Fill in MODEL_API_KEY and TELEGRAM_BOT_TOKEN

# Server
cd server
pip install -e ".[dev]"

# Web
cd apps/web
npm install
```

### Run

```bash
# Both server and web (requires make)
make dev

# Or separately:
cd server && uvicorn server.app:app --reload --port 8000
cd apps/web && npm run dev
```

### Test

```bash
make test
```

### Tunnel (for phone testing)

```bash
cloudflared tunnel --url http://localhost:5173
# or: ngrok http 5173
```

## Layout

```
apps/web/     React + Vite PWA (camera, Tier 1 detector, arbiter, TTS)
server/       FastAPI (meta_client.py, vision.py, nav.py, profile.py, emergency.py, phrases.py)
eval/         clips/ (gitignored), labels.csv, run_eval.py, spend.jsonl (gitignored)
shared/       phrases.json (en + hi, used by both web and server)
```

See `AGENTS.md` for architecture and conventions.
