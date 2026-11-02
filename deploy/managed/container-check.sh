#!/bin/sh
# Prove the Linux lock-down inside a disposable container.
#
# Everything here runs as root *inside* the container. The host is never
# touched: the repository is mounted read-only and no host path is written.
# The script installs the three CLIs, generates a bundle, installs it with
# deploy/managed/install.sh, then shows a user-level override being ignored.

set -eu

SRC=${SRC:-/src}
BUNDLE=${BUNDLE:-/tmp/taa-setup-bundle}
export HOME=${HOME:-/root}
export PATH="$HOME/.opencode/bin:$PATH"

say() {
  printf '\n== %s ==\n' "$1"
}

fail() {
  printf '\nFAIL: %s\n' "$1" >&2
  exit 1
}

MOCK_PID=""
cleanup() {
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

say "container"
id
cat /etc/os-release | sed -n '1,3p'
node --version
npm --version

say "install the verified CLI versions"
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl bash >/tmp/apk.log 2>&1 || {
    tail -20 /tmp/apk.log
    fail "apk add curl bash"
  }
elif ! command -v curl >/dev/null 2>&1; then
  fail "curl is required to install OpenCode"
fi

npm install -g @anthropic-ai/claude-code@2.1.316 @openai/codex@0.165.0 >/tmp/npm-install.log 2>&1 || {
  tail -30 /tmp/npm-install.log
  fail "npm install of Claude Code / Codex"
}

curl -fsSL https://opencode.ai/v2/install | bash >/tmp/opencode-install.log 2>&1 || {
  tail -30 /tmp/opencode-install.log
  fail "OpenCode install"
}
export PATH="$HOME/.opencode/bin:$PATH"

claude --version
codex --version
opencode --version
case "$(opencode --version 2>&1)" in
  *"v2."* | *"2."*) ;;
  *) fail "expected OpenCode 2" ;;
esac

say "generate the setup bundle from the example spec"
# Point every client at a local mock so the Claude proof can exercise a real
# request without reaching any provider.
node -e '
  const fs = require("node:fs");
  const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  spec.team.gatewayUrl = "http://127.0.0.1:4020";
  fs.writeFileSync(process.argv[2], JSON.stringify(spec));
' "$SRC/deploy/managed/example-setup.json" /tmp/container-spec.json
TAA_MEMBER_KEY=inert-key-0001 node "$SRC/src/setup/cli.ts" \
  --spec /tmp/container-spec.json \
  --out "$BUNDLE"

say "install managed files as root (inside this container only)"
sh "$SRC/deploy/managed/install.sh" "$BUNDLE" --yes

say "installed modes and ownership"
for file in \
  /etc/claude-code/managed-settings.json \
  /etc/claude-code/managed-mcp.json \
  /etc/opencode/opencode.json \
  /etc/codex/requirements.toml \
  /etc/codex/managed_config.toml; do
  stat -c '%a %U:%G %n' "$file"
done

say "the plugin path named by the managed config is present"
mkdir -p /etc/opencode/plugins
cat >/etc/opencode/plugins/team-ai-allowance.ts <<'PLUGIN'
// Inert stand-in for the budget plugin: enough for config loading.
export const server = async () => ({})
PLUGIN
stat -c '%a %U:%G %n' /etc/opencode/plugins/team-ai-allowance.ts

# The member env is not installed by root. Source it here as the member would.
# shellcheck disable=SC1090
. "$BUNDLE/member/taa.env"

say "OpenCode: user override tries another provider and model"
mkdir -p "$HOME/.config/opencode"
cat >"$HOME/.config/opencode/opencode.json" <<'USER'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "npm": "@ai-sdk/anthropic",
      "name": "User provider",
      "options": {},
      "models": { "claude-sonnet-4": { "name": "Sonnet" } }
    }
  },
  "model": "anthropic/claude-sonnet-4",
  "mcp": { "evil": { "type": "local", "command": ["evil"], "enabled": true } }
}
USER

opencode models --standalone >/tmp/opencode-models.txt 2>/tmp/opencode-models.err || {
  cat /tmp/opencode-models.err
  fail "opencode models"
}
echo "models visible to the member:"
sed 's/^/  /' /tmp/opencode-models.txt
if grep -Eiq 'anthropic|claude|evil' /tmp/opencode-models.txt; then
  fail "user provider is still usable"
fi
grep -q 'team-gateway/deepseek-v4.1-flash' /tmp/opencode-models.txt ||
  fail "gateway model is missing from the visible list"
echo "proven: the user provider override is ignored; only gateway models are visible"

opencode debug config >/tmp/opencode-debug-config.json 2>/tmp/opencode-debug-config.err || {
  cat /tmp/opencode-debug-config.err
  fail "opencode debug config"
}
grep -q '"/etc/opencode/opencode.json"' /tmp/opencode-debug-config.json ||
  fail "managed OpenCode file is not listed as a config source"
grep -q '"providerID": "team-gateway"' /tmp/opencode-debug-config.json ||
  fail "managed model does not select team-gateway"
echo "proven: /etc/opencode/opencode.json is a config source and selects team-gateway"

say "Codex: user override tries another provider/model and an extra MCP server"
mkdir -p "$HOME/.codex"
cat >"$HOME/.codex/config.toml" <<'USER'
model = "user-model"
model_provider = "user-provider"

[model_providers.user-provider]
name = "User provider"
base_url = "https://evil.example.com/v1"
env_key = "EVIL_KEY"
wire_api = "responses"

[mcp_servers.evil]
command = "evil"
args = []
USER

codex doctor >/tmp/codex-doctor.txt 2>&1 || true
sed -n '/^Configuration/,/^$/p' /tmp/codex-doctor.txt
if grep -q 'deepseek-v4.1-flash · team-gateway' /tmp/codex-doctor.txt; then
  echo "proven: managed_config.toml wins at startup over the user's provider/model"
  CODEX_CONFIG_PROVEN=1
else
  echo "NOT PROVEN: Codex doctor did not show the managed model/provider"
  CODEX_CONFIG_PROVEN=0
fi
if grep -Eq 'disabled servers +1' /tmp/codex-doctor.txt && ! grep -q 'evil' /tmp/codex-doctor.txt; then
  echo "proven: requirements.toml MCP allowlist disabled the user's extra server"
  CODEX_MCP_PROVEN=1
else
  echo "NOT PROVEN: Codex doctor did not show the MCP allowlist result"
  CODEX_MCP_PROVEN=0
fi

say "Claude Code: user override tries another gateway"
rm -f /tmp/mock-requests.log
MOCK_LOG=/tmp/mock-requests.log node "$SRC/deploy/managed/mock-anthropic.mjs" \
  >/tmp/mock.out 2>/tmp/mock.err &
MOCK_PID=$!
sleep 1
mkdir -p /tmp/claude-home/.claude
cat >/tmp/claude-home/.claude/settings.json <<'USER'
{
  "env": { "ANTHROPIC_BASE_URL": "https://evil.example.com" },
  "availableModels": ["user-only-model"]
}
USER
(
  cd /tmp/claude-home
  # Drop the shell copy so only managed-settings.json can set the base URL.
  unset ANTHROPIC_BASE_URL
  HOME=/tmp/claude-home \
    CLAUDE_CONFIG_DIR=/tmp/claude-home/.claude \
    claude -p "reply OK" --model deepseek-v4.1-flash --output-format json \
    >/tmp/claude-proof.json 2>/tmp/claude-proof.err
) || true
if node -e '
  const fs = require("node:fs");
  try {
    const result = JSON.parse(fs.readFileSync("/tmp/claude-proof.json", "utf8"));
    process.exit(result.is_error === false && result.result === "OK" ? 0 : 1);
  } catch { process.exit(1); }
' && grep -q '"model":"deepseek-v4.1-flash"' /tmp/mock-requests.log 2>/dev/null &&
  grep -q '"auth":"bearer"' /tmp/mock-requests.log 2>/dev/null; then
  echo "proven: the mock gateway answered, so managed-settings.json env.ANTHROPIC_BASE_URL"
  echo "        beat the user's settings.json and no shell copy was present"
  CLAUDE_PROVEN=1
else
  echo "NOT PROVEN: Claude Code did not reach the mock gateway through managed settings"
  cat /tmp/claude-proof.err 2>/dev/null || true
  CLAUDE_PROVEN=0
fi
cleanup
MOCK_PID=""

say "result"
printf 'OpenCode provider lock: proven\n'
printf 'Codex managed config:  %s\n' "$([ "$CODEX_CONFIG_PROVEN" = 1 ] && echo proven || echo not-proven)"
printf 'Codex MCP allowlist:   %s\n' "$([ "$CODEX_MCP_PROVEN" = 1 ] && echo proven || echo not-proven)"
printf 'Claude managed file:   %s\n' "$([ "$CLAUDE_PROVEN" = 1 ] && echo proven || echo not-proven)"
printf '\nThe host was not modified: this all ran inside the container.\n'
