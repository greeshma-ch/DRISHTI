.PHONY: dev dev-server dev-web test test-server test-web typecheck-web lint lint-server lint-web build-web check tunnel

# ── Dev ──────────────────────────────────────────────────
dev: dev-server dev-web

dev-server:
	PYTHONPATH=. uvicorn server.app:app --reload --host 0.0.0.0 --port 8000

dev-web:
	npm --prefix apps/web install
	npm --prefix apps/web run dev

# ── Test ─────────────────────────────────────────────────
test: test-server test-web

test-server:
	PYTHONPATH=. python -m pytest server/tests -q

test-web:
	npm --prefix apps/web test -- --run

# ── Typecheck, lint, and build ───────────────────────────
typecheck-web:
	npm --prefix apps/web run typecheck

lint: lint-server lint-web

lint-server:
	ruff check server

lint-web:
	npm --prefix apps/web run lint

build-web:
	npm --prefix apps/web run build

check: test-web typecheck-web lint-web build-web test-server lint-server

# ── Tunnel ───────────────────────────────────────────────
tunnel:
	@echo "Run one of:"
	@echo "  cloudflared tunnel --url http://localhost:5173"
	@echo "  ngrok http 5173"
