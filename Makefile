.PHONY: dev dev-server dev-web test test-server test-web lint lint-server lint-web tunnel

# ── Dev ──────────────────────────────────────────────────
dev: dev-server dev-web

dev-server:
	PYTHONPATH=. uvicorn server.app:app --reload --host 0.0.0.0 --port 8000

dev-web:
	cd apps/web && npm install && npm run dev

# ── Test ─────────────────────────────────────────────────
test: test-server test-web

test-server:
	PYTHONPATH=. python -m pytest server/tests -q

test-web:
	cd apps/web && npx vitest run

# ── Lint ─────────────────────────────────────────────────
lint: lint-server lint-web

lint-server:
	ruff check server

lint-web:
	cd apps/web && npm run lint && npm run typecheck

# ── Tunnel ───────────────────────────────────────────────
tunnel:
	@echo "Run one of:"
	@echo "  cloudflared tunnel --url http://localhost:5173"
	@echo "  ngrok http 5173"
