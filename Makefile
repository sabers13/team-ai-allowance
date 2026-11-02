SHELL := /bin/sh
NODE := node
NPM := npm

.PHONY: setup lint format typecheck test e2e scan-forbidden scan-secrets facts \
	facts-write stack-up stack-down stack-logs gateway-it demo sim live-check page all release-check \
	lockdown-check

setup:
	$(NPM) ci

lint:
	npx biome check .

format:
	npx biome format --write .

typecheck:
	npx tsc --noEmit

test:
	$(NPM) test

e2e:
	$(NPM) run e2e

scan-forbidden:
	$(NODE) scripts/scan-forbidden.ts

scan-secrets:
	$(NODE) scripts/scan-secrets.ts

facts:
	$(NODE) scripts/facts.ts

facts-write:
	$(NODE) scripts/facts.ts --write

stack-up:
	sh deploy/stack.sh up

stack-down:
	sh deploy/stack.sh down

stack-logs:
	sh deploy/stack.sh logs

gateway-it:
	sh deploy/gateway-it.sh

lockdown-check:
	sh deploy/managed/lockdown-check.sh

demo:
	@$(NODE) scripts/demo.ts

sim:
	$(NODE) src/sim/run.ts

live-check:
	$(NODE) scripts/live-check.ts

page:
	$(NODE) web/build.ts

release-check: lint typecheck test scan-forbidden scan-secrets facts
	@echo "release-check: green"

all: release-check e2e
