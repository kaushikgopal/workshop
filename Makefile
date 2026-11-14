.PHONY: setup check dev start

setup:
	@if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then \
		if [ "$$(uname -s)" = "Darwin" ]; then \
			if ! command -v brew >/dev/null 2>&1; then echo "Node 24+ is required; install Homebrew, then run make setup again." >&2; exit 1; fi; \
			brew install node; \
		else \
			echo "Node 24+ is required. Install it, then run make setup again." >&2; exit 1; \
		fi; \
	fi
	@node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node 24+ is required."); process.exit(1); }'
	@npm ci
	@test -f workshop.yaml || cp workshop.example.yaml workshop.yaml
	@test -f .env.local || cp .env.example .env.local

check:
	@node scripts/check-config.ts
	@npm run typecheck
	@npm test

dev:
	@npm run dev

start:
	@npm run build && npm run start
