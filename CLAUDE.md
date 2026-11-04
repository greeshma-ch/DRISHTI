Read and follow @AGENTS.md and PROGRESS.md .


Shell rules: never use cd, "cd && ..." chains or computed paths. Stay in the repo root. Use npm --prefix apps/web ..., python3 -m pytest server/tests, and plain git status. Keep each shell command under 800 bytes. Create files with file tools, not heredocs.
