#!/usr/bin/env bash
# SSM target: tina-core i-08e90a7723e74a498 (us-east-1)
# Precondition: workflow aws-demo-repair.yml published both :aws-final images to GHCR.
set -Eeuo pipefail

BASE=/opt/tina-demo/deploy/compose
ENV=/etc/tina-demo/core.env
PASS=/etc/tina-demo/password-demo.yml
OVER=/etc/tina-demo/aws-final.yml
PREV=/etc/tina-demo/aws-final.yml.before-last-deploy
CORE_IP=10.20.2.133
TERM_IMAGE=ghcr.io/namtv2712/tina-v012-terminal:aws-final
MEETING_IMAGE=ghcr.io/namtv2712/tina-v012-meeting-api:aws-final
APPLIED=0
CONFIG_CHANGED=0
EXISTED=0

compose() {
  docker compose --project-directory "$BASE" --env-file "$ENV" \
    -f "$BASE/docker-compose.yml" \
    -f "$BASE/docker-compose.aws-core.yml" \
    -f "$PASS" \
    -f "$OVER" "$@"
}
rollback() {
  rc=$?
  trap - ERR
  echo "DEPLOY FAILED (exit $rc)"
  if [ "$CONFIG_CHANGED" = 1 ]; then
    echo '=== RESTORE PREVIOUS OVERRIDE ==='
    if [ "$EXISTED" = 1 ] && [ -f "$PREV" ]; then
      cp -p "$PREV" "$OVER"
    else
      # Original Compose does not use the new overlay; restore previous tags explicitly.
      cat > "$OVER" <<'YAML'
services:
  terminal:
    image: ghcr.io/namtv2712/tina-v012-terminal:password-demo
  meeting-api:
    image: ghcr.io/namtv2712/tina-v012-meeting-api:aws-demo
YAML
    fi
    if [ "$APPLIED" = 1 ]; then
      echo '=== RESTORE PREVIOUS CONTAINERS ==='
      compose up -d --no-deps --force-recreate terminal meeting-api || true
    fi
  fi
  exit "$rc"
}
trap rollback ERR

echo '=== TINA AWS FINAL PATCH ==='
[ -f "$ENV" ] && [ -f "$PASS" ] && [ -f "$BASE/docker-compose.aws-core.yml" ] || {
  echo 'Missing existing TINA Core deployment files; stopped safely.'; exit 1;
}

if docker ps --format '{{.Names}}' | grep -Eq '^tina-mtg-'; then
  echo 'STOP: Active meeting Bot detected. End the bot in TINA first to avoid disruption.'
  exit 2
fi

echo '=== PRE-DEPLOY HEALTH ==='
for name in tina-v012-terminal-1 tina-v012-meeting-api-1; do
  docker inspect --format '{{.Name}} | {{.State.Status}} | {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name"
done

echo '=== DOWNLOAD VERIFIED BUILDS ==='
docker pull "$TERM_IMAGE"
docker pull "$MEETING_IMAGE"

echo '=== BACKUP CURRENT CONFIG ==='
if [ -f "$OVER" ]; then
  EXISTED=1
  cp -p "$OVER" "$PREV"
fi
CONFIG_CHANGED=1

cat > "$OVER" <<YAML
# TINA demo only: separate Speech EC2 is always-on; no cross-host Docker lifecycle.
services:
  terminal:
    image: ${TERM_IMAGE}
    environment:
      TINA_ASR_CONTROL_MODE: "aws-remote"
      TINA_AWS_ASR_GIPFORMER_URL: "http://${CORE_IP}:18002"
      TINA_AWS_ASR_VIEGEM_URL: "http://${CORE_IP}:18005"
  meeting-api:
    image: ${MEETING_IMAGE}
    environment:
      TINA_AWS_NATIVE_VOICE_DEFAULT: "1"
YAML
chmod 600 "$OVER"

echo '=== VALIDATE COMPOSE BEFORE CHANGING CONTAINERS ==='
compose config --quiet

echo '=== DEPLOY ONLY TERMINAL + MEETING API ==='
APPLIED=1
compose up -d --no-deps --force-recreate --pull never terminal meeting-api

wait_healthy() {
  local name="$1" status=""
  for i in $(seq 1 36); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)
    if [ "$status" = healthy ]; then
      echo "$name HEALTHY"
      return 0
    fi
    if [ "$status" = unhealthy ] || [ "$status" = exited ]; then
      echo "$name: $status"
      return 1
    fi
    sleep 5
  done
  echo "$name: health timed out ($status)"
  return 1
}

wait_healthy tina-v012-meeting-api-1
wait_healthy tina-v012-terminal-1

echo '=== VERIFY PASSWORD LOGIN ==='
docker exec tina-v012-terminal-1 node -e '
(async () => {
 const r = await fetch("http://127.0.0.1:3000/api/auth/password", { signal: AbortSignal.timeout(8000) });
 if (r.status !== 200 || (await r.json()).enabled !== true) throw Error("password login disabled");
 console.log("PASSWORD LOGIN: ENABLED");
})().catch(e => { console.error("PASSWORD LOGIN: FAILED"); process.exit(1); });'

echo '=== VERIFY REMOTE ASR CONFIG ==='
docker exec tina-v012-terminal-1 node -e '
(async () => {
 if (process.env.TINA_ASR_CONTROL_MODE !== "aws-remote") throw Error("wrong mode");
 for (const [name, key, expected] of [
  ["GIPFORMER", "TINA_AWS_ASR_GIPFORMER_URL", "g-group-ai-lab/gipformer1.5-68M-rnnt"],
  ["VIEGEM", "TINA_AWS_ASR_VIEGEM_URL", "5CD-AI/VieGem-ASR"]
 ]) {
  const base = process.env[key]; if (!base) throw Error(name + " URL not set");
  const r = await fetch(base + "/status", { signal: AbortSignal.timeout(10000) });
  const body = await r.json();
  if (!r.ok || body.model?.asr_model !== expected) throw Error(name + " worker not ready");
  console.log(name + ": READY");
 }
})().catch(e => { console.error("ASR CHECK FAILED: " + e.message); process.exit(1); });'

echo '=== VERIFY VOICE CONFIG ==='
docker exec -i tina-v012-meeting-api-1 python - <<'PY'
import os
assert os.getenv('TINA_MEETING_VOICE') == '1', 'voice was not enabled'
assert os.getenv('TINA_AWS_NATIVE_VOICE_DEFAULT') == '1', 'new-room default not configured'
assert os.getenv('TTS_SERVICE_URL'), 'TTS endpoint missing'
print('TINA VOICE: ENABLED; NEW MEETING DEFAULT: TINA')
PY

echo '=== SUCCESS: AWS TWO-EC2 DEMO PATCH DEPLOYED ==='
trap - ERR
