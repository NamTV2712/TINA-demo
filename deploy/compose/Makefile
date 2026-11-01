# deploy/compose — the TINA control-plane stack + its readiness proof.
#
# The stack-readiness proof (tests/stack_test.py) owns the full up→prove→down lifecycle in its
# session fixture, so `make stack-test` is the one entrypoint the gate calls. The bare up/down
# targets below are for hand-driving the stack during development.
ENV_FILE ?= .env
ALLOW_CONFIG_CHANGE ?= 1
export ENV_FILE PROJECT COMPOSE_PROJECT EMAIL SCOPES BOT_IMAGE DESTROY ALLOW_CONFIG_CHANGE
BROWSER_IMAGE ?= mock-bot:dev
EMAIL ?= self-host@tina.test
SCOPES ?= bot,tx
COMPOSE = python3 ./bin/stack.py compose
# Images are built from this checkout. `make bot` builds the browser image separately when needed.
REPO_ROOT := $(abspath ../..)

.PHONY: stack-test stack-test-bot stack-test-mock stack-test-v010 dashboard-harness provision-token up dev down destroy help build ps logs bot _preflight _bot_check _creds_check _access _storage_note migrate-storage all plan doctor

## provision-token — mint (idempotently) the self-host dashboard's API token (compose bring-up step 2).
## Needs ADMIN_TOKEN (the stack admin secret). Prints ONLY the token, so it pipes into the deploy:
##   DASHBOARD_API_KEY=$$(make -s provision-token ADMIN_TOKEN=<secret>) \
##     docker compose -f docker-compose.yml -f docker-compose.dashboard.yml up -d dashboard
provision-token:
	@python3 ./bin/stack.py token

## dashboard-harness — the dashboard FULL-SURFACE proof: send-bot + live WS transcript through the
## vendored dashboard, against the real stack + the mock bot (deterministic, no browser/STT/meeting).
## Needs mock-bot:dev + tina-dashboard:dev (docker build -f clients/dashboard/Dockerfile --build-arg
## TINA_API_URL=http://gateway:8000 -t tina-dashboard:dev ../.. from the repo root).
dashboard-harness:
	./bin/dashboard-harness.sh

## stack-test — the always-on gate:compose proof (brings the stack up + down itself).
stack-test:
	./bin/stack-test

## stack-test-bot — + the real bot-spawn proof (COMPOSE_BOT=1; slow, builds the bot locally).
stack-test-bot:
	COMPOSE_BOT=1 ./bin/stack-test

## stack-test-stress — the control plane under CONCURRENT load (A:V2): N mock bots at once, no cap overspill.
## Needs mock-bot:dev. Tune STRESS_N / STRESS_CAP. Pass COMPOSE_PROJECT + STORAGE_HOST_PORT to isolate on a shared dev host.
stack-test-stress:
	COMPOSE_STRESS=1 MOCK_BOT=1 BROWSER_IMAGE=$(BROWSER_IMAGE) ./bin/stack-test

## stack-test-chaos — the control plane RECOVERS from injected faults (A:V3): a redis/meeting-api blip
## (docker pause/unpause) mid-run → the FSM still reaches terminal. Needs mock-bot:dev.
stack-test-chaos:
	COMPOSE_CHAOS=1 MOCK_BOT=1 BROWSER_IMAGE=$(BROWSER_IMAGE) ./bin/stack-test chaos_test.py

## stack-test-mock — the FULL control-plane lifecycle at L3 via the mock bot (A:V1). Needs mock-bot:dev
## (build: docker build -f ../../core/meetings/services/bot/Dockerfile.mock -t mock-bot:dev ../../). Runs
## the always-on subset PLUS the MOCK_BOT scenarios (normal/reject/crash/timeout/emit/stop/max-bots/
## speak/canAccess) — no browser/STT. Pass COMPOSE_PROJECT to isolate on a shared host.
stack-test-mock:
	MOCK_BOT=1 BROWSER_IMAGE=$(BROWSER_IMAGE) ./bin/stack-test

## stack-test-v010 — the 0.10 API backward-compat behavioral suite (release DoD 6): a 0.10-style
## client's real REST + WS flows against the running 0.12 stack, MOCK_BOT scenarios only. Opt-in
## via V010_COMPAT=1 (without it the compat dir is not even collected — the default gate:compose
## collection is unchanged). Needs mock-bot:dev, like stack-test-mock. Runs ONLY tests/compat/.
stack-test-v010:
	V010_COMPAT=1 MOCK_BOT=1 BROWSER_IMAGE=$(BROWSER_IMAGE) ./bin/stack-test compat

## Source builds complete before activation. No mixed recursive-Make shell recipes:
## GNU Make executes those even with -n. All deployment orchestration lives in stack.py.
all up dev:
	@python3 ./bin/stack.py all

build:
	@python3 ./bin/stack.py build

bot:
	@python3 ./bin/stack.py bot

plan:
	@python3 ./bin/stack.py plan

doctor:
	@python3 ./bin/stack.py doctor

_preflight:
	@python3 ./bin/stack.py preflight

_bot_check:
	@python3 ./bin/stack.py check-images

_creds_check:
	@python3 ./bin/stack.py capabilities

_access:
	@python3 ./bin/stack.py access

_storage_note:
	@$(COMPOSE) logs --no-log-prefix --tail 20 storage-init 2>/dev/null | grep -E '^\[storage-init\] (WARNING|STOP):' | tail -n 1 || true

## migrate-storage — upgrading a stack that ran MinIO: copy every object from the old MinIO into the
## `storage` service and verify each one by SHA-256 (deploy/storage/migrate-from-minio.sh + s3_copy.py,
## run with the meeting-api image's Python). Resumable; deletes nothing; the old volume is only read.
## It reads through the old `minio` container while Compose still runs it as an orphan, else through a
## temporary MinIO started from that container's image, else LEGACY_MINIO_IMAGE if it is on this
## machine (nothing is pulled). Credentials default to the .env MINIO_* values, which both servers use.
## Guide: docs/docs/upgrade-from-minio.mdx.
LEGACY_MINIO_CONTAINER ?=
LEGACY_MINIO_VOLUME    ?=
LEGACY_MINIO_IMAGE     ?=
# Empty uses MINIO_BUCKET from .env (or tina); overrides both migration bucket defaults.
export LEGACY_MINIO_CONTAINER LEGACY_MINIO_VOLUME
MIGRATE_BUCKET        ?=
migrate-storage:
	@set -e; \
	envv() { grep -E "^$$1=" "$${ENV_FILE:-.env}" 2>/dev/null | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$$//; s/[[:space:]]+$$//'; }; \
	STACK_PROJECT=$$(python3 ./bin/stack.py project); \
	AK=$$(envv MINIO_ACCESS_KEY); AK=$${AK:-tina-access-key}; SK=$$(envv MINIO_SECRET_KEY); SK=$${SK:-tina-secret-key}; \
	BK="$(MIGRATE_BUCKET)"; BK=$${BK:-$$(envv MINIO_BUCKET)}; BK=$${BK:-tina}; TAG=$$(envv IMAGE_TAG); TAG=$${IMAGE_TAG:-$${TAG:-dev}}; \
	$(COMPOSE) up -d --no-build storage; \
	NETWORK=$${STACK_PROJECT}_tina LEGACY_VOLUME="$${LEGACY_MINIO_VOLUME:-$${STACK_PROJECT}_minio-data}" LEGACY_CONTAINER="$${LEGACY_MINIO_CONTAINER:-$${STACK_PROJECT}-minio-1}" \
	LEGACY_IMAGE="$(LEGACY_MINIO_IMAGE)" LEGACY_ACCESS_KEY="$${LEGACY_MINIO_ACCESS_KEY:-$$AK}" \
	LEGACY_SECRET_KEY="$${LEGACY_MINIO_SECRET_KEY:-$$SK}" LEGACY_BUCKET="$${LEGACY_MINIO_BUCKET:-$$BK}" \
	TARGET_ENDPOINT=http://storage:9000 TARGET_ACCESS_KEY="$$AK" TARGET_SECRET_KEY="$$SK" TARGET_BUCKET="$$BK" \
	STORAGE_VOLUME=$${STACK_PROJECT}_storage-data RUN_IMAGE="tina/v012-meeting-api:$$TAG" RUN_PYTHON=python \
	TOOLS_DIR=$(REPO_ROOT)/deploy/storage NAME_PREFIX=$${STACK_PROJECT} RETRY_HINT="make -C deploy/compose migrate-storage" \
	COPY_ARGS="$(COPY_ARGS)" $(REPO_ROOT)/deploy/storage/migrate-from-minio.sh

## down keeps data volumes; destroy requires explicit DESTROY=yes in the script as well.
down:
	@python3 ./bin/stack.py down

destroy:
	@python3 ./bin/stack.py destroy

help:
	@echo "  make plan                       # resolved project, files, services and build order; read-only"
	@echo "  make all                        # build every required image, start, wait and provision access"
	@echo "  make build                      # source build only; no service activation"
	@echo "  make doctor                     # inspect image availability and service readiness; read-only"
	@echo "  make down                       # stop/remove selected project; keep data volumes"
	@echo "  make destroy DESTROY=yes         # delete selected project and its data volumes"
	@echo "  make migrate-storage            # copy and verify older MinIO recordings"
	@echo "  ENV_FILE / PROJECT / COMPOSE_FILE / COMPOSE_PROFILES select the deployment."

ps:
	@python3 ./bin/stack.py ps

logs:
	@python3 ./bin/stack.py logs
