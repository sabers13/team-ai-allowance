#!/bin/sh
# Bring the local gateway stack up or down.
#
# Usage: deploy/stack.sh up|down|logs|status
#
# The stack is a podman compose project named `taa`, so every container is
# `taa-*`. Secrets are generated once into `deploy/.env` (mode 0600, ignored by
# git) and are never printed. All host ports bind 127.0.0.1.
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${TAA_STACK_ENV:-"$DEPLOY_DIR/.env"}

compose() {
  if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    podman compose -p taa \
      --project-directory "$DEPLOY_DIR" \
      -f "$DEPLOY_DIR/compose.yaml" \
      --env-file "$ENV_FILE" "$@"
  elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose -p taa \
      --project-directory "$DEPLOY_DIR" \
      -f "$DEPLOY_DIR/compose.yaml" \
      --env-file "$ENV_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -p taa \
      --project-directory "$DEPLOY_DIR" \
      -f "$DEPLOY_DIR/compose.yaml" \
      --env-file "$ENV_FILE" "$@"
  else
    echo "stack: neither podman compose nor docker compose is available" >&2
    exit 1
  fi
}

random_hex() {
  od -An -N"${1:-24}" -tx1 /dev/urandom | tr -d ' \n'
}

value_of() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

port_of() {
  value=$(value_of "$1")
  if [ -z "$value" ]; then
    printf '%s\n' "$2"
  else
    printf '%s\n' "$value"
  fi
}

ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    return
  fi
  umask 077
  cat >"$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=taa
TAA_GATEWAY_PORT=14000
TAA_POSTGRES_PORT=15432
TAA_CONSOLE_PORT=18080
TAA_MAIL_UI_PORT=18025
TAA_WEBHOOK_PORT=18090
TAA_MOCK_PORT=14001
POSTGRES_PASSWORD=$(random_hex 24)
LITELLM_MASTER_KEY=sk-$(random_hex 24)
MOCK_UPSTREAM_KEY=mock-$(random_hex 16)
TAA_SESSION_SECRET=$(random_hex 32)
TAA_CSRF_SECRET=$(random_hex 32)
TAA_DEMO_MANAGER_PASSWORD=$(random_hex 12)
EOF
  chmod 600 "$ENV_FILE"
  echo "stack: generated secrets in deploy/.env (mode 600); values are not printed"
}

ensure_var() {
  if ! grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

# Ensure control-service secrets exist in .env when upgrading an older local env.
ensure_control_secrets() {
  ensure_var TAA_SESSION_SECRET "$(random_hex 32)"
  ensure_var TAA_CSRF_SECRET "$(random_hex 32)"
  ensure_var TAA_DEMO_MANAGER_PASSWORD "$(random_hex 12)"
}

cmd=${1:-up}
shift || true
case "$cmd" in
  up)
    ensure_env
    ensure_control_secrets
    if [ "${TAA_STACK_BUILD:-0}" = "1" ]; then
      compose up -d --build
    else
      compose up -d
    fi
    echo "stack: gateway   http://127.0.0.1:$(port_of TAA_GATEWAY_PORT 14000)"
    echo "stack: postgres  127.0.0.1:$(port_of TAA_POSTGRES_PORT 15432)"
    echo "stack: console   http://127.0.0.1:$(port_of TAA_CONSOLE_PORT 18080)"
    echo "stack: health    http://127.0.0.1:$(port_of TAA_CONSOLE_PORT 18080)/health"
    echo "stack: mail UI   http://127.0.0.1:$(port_of TAA_MAIL_UI_PORT 18025)"
    echo "stack: webhook   http://127.0.0.1:$(port_of TAA_WEBHOOK_PORT 18090)"
    echo "stack: mock      http://127.0.0.1:$(port_of TAA_MOCK_PORT 14001)"
    echo "stack: demo login priya@example.test (password in deploy/.env, mode 600)"
    ;;
  down)
    if [ -f "$ENV_FILE" ]; then
      if [ "${TAA_KEEP_DATA:-0}" = "1" ]; then
        compose down --remove-orphans
      else
        compose down --remove-orphans -v
      fi
    else
      echo "stack: no deploy/.env, nothing to stop"
    fi
    ;;
  logs)
    compose logs --tail=200 "$@"
    ;;
  status)
    compose ps "$@"
    ;;
  *)
    echo "usage: deploy/stack.sh up|down|logs|status" >&2
    exit 2
    ;;
esac
