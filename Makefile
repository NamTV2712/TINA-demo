# =============================================================================
# TINA — self-hosted Docker Compose entrypoint
# =============================================================================
.PHONY: all up dev down bot lite probe login help plan build doctor ps logs cli-install

SURFACE ?= compose
ALLOW_CONFIG_CHANGE ?= 1
export ALLOW_CONFIG_CHANGE

help:
	@echo "TINA self-hosted deploy:"
	@echo "  make all   build and start the full Docker Compose stack from this checkout"
	@echo "  make plan  show resolved deployment and build order (read-only)"
	@echo "  make build build all required Compose and worker images without starting services"
	@echo "  make doctor inspect Compose readiness (read-only); make ps / make logs for status"
	@echo "  make dev   same source-built stack with development defaults"
	@echo "  make bot   build the meeting bot from source"
	@echo "  make lite  build and run the single-container TINA Lite stack"
	@echo "  make probe full-journey smoke probe of a RUNNING install (SURFACE=compose|lite|helm)"
	@echo "  make login provision an authenticated-bot session (sign in once; uploads to userdata storage)"
	@echo "  make down  stop the compose stack"
	@echo "  make cli-install install tina CLI/TUI in ~/.local/bin"

all up: dev          ## build and start the full compose stack from source

lite:                ## single-container TINA Lite (build + run + verify) — see deploy/lite
	@$(MAKE) --no-print-directory -C deploy/lite all

dev:                 ## full stack built from this checkout
	@$(MAKE) --no-print-directory -C deploy/compose dev

bot:                 ## build the meeting bot from source
	@$(MAKE) --no-print-directory -C deploy/compose bot

probe:               ## full-journey smoke probe (spawn→…→stop + log sweep) of a running install — see deploy/$(SURFACE)/probe.sh
	@./deploy/$(SURFACE)/probe.sh

login:               ## provision an authenticated-bot session — sign in once, persist it (docs: /authenticated-bots)
	@pnpm --filter @tina/remote-browser login

down:                ## stop the compose stack
	@$(MAKE) --no-print-directory -C deploy/compose down

plan build doctor ps logs:
	@$(MAKE) --no-print-directory -C deploy/compose $@

cli-install:
	@python3 deploy/compose/bin/install-tina.py
