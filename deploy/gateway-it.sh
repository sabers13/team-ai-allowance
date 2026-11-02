#!/bin/sh
# Opt-in integration check: bring the stack up, run the gateway client against
# the real pinned LiteLLM, print the result and tear the stack down again.
#
# Usage: make gateway-it
# Keep the stack afterwards with TAA_KEEP_STACK=1.
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$DEPLOY_DIR/.." && pwd)
ENV_FILE=${TAA_STACK_ENV:-"$DEPLOY_DIR/.env"}
WAIT_SECONDS=${TAA_IT_WAIT_SECONDS:-300}

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

cleanup() {
  if [ "${TAA_KEEP_STACK:-0}" = "1" ]; then
    echo "gateway-it: stack left running (TAA_KEEP_STACK=1)"
    return
  fi
  sh "$DEPLOY_DIR/stack.sh" down >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "$ROOT"
sh "$DEPLOY_DIR/stack.sh" up

GATEWAY_PORT=$(port_of TAA_GATEWAY_PORT 14000)
MOCK_PORT=$(port_of TAA_MOCK_PORT 14001)
WEBHOOK_PORT=$(port_of TAA_WEBHOOK_PORT 18090)
HEALTH="http://127.0.0.1:$GATEWAY_PORT/health/liveliness"

echo "gateway-it: waiting for $HEALTH (up to ${WAIT_SECONDS}s)"
elapsed=0
until curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; do
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$WAIT_SECONDS" ]; then
    echo "gateway-it: gateway did not become healthy in ${WAIT_SECONDS}s" >&2
    echo "gateway-it: inspect with 'deploy/stack.sh logs litellm'" >&2
    exit 1
  fi
  sleep 1
done

# The other services must be reachable too; a green run should mean the whole
# shape came up, not only the proxy.
for check in "mock:$MOCK_PORT/health" "webhook:$WEBHOOK_PORT/health"; do
  name=${check%%:*}
  path=${check#*:}
  url="http://127.0.0.1:$path"
  n=0
  until curl -fsS --max-time 2 "$url" >/dev/null 2>&1; do
    n=$((n + 1))
    if [ "$n" -ge 30 ]; then
      echo "gateway-it: $name did not become healthy at $url" >&2
      exit 1
    fi
    sleep 1
  done
done

TAA_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT"
LITELLM_MASTER_KEY=$(value_of LITELLM_MASTER_KEY)
export TAA_GATEWAY_URL LITELLM_MASTER_KEY

node test/gateway/integration.ts
