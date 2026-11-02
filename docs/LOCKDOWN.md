# Lock-down: what the setup pack enforces

Status: 2026-10-31. The Linux path is proven in a container
(`make lockdown-check`); the macOS MDM profiles are generated templates and
are not proven on a real Mac.

The setup pack turns a team spec (gateway, model catalogue, MCP server) and
one member enrolment into managed configuration for the three clients. The
member gateway key goes into a mode-0600 environment file and nowhere else.

## What is generated

| File | Installed at (Linux) | Purpose |
| --- | --- | --- |
| `managed/claude-code/managed-settings.json` | `/etc/claude-code/managed-settings.json` | Gateway base URL, `availableModels`, default model, `allowedProviders: ["customEndpoint"]` |
| `managed/claude-code/managed-mcp.json` | `/etc/claude-code/managed-mcp.json` | Exclusive MCP server set: only `taa mcp` loads |
| `managed/opencode/opencode.json` | `/etc/opencode/opencode.json` | Gateway-only provider, default model, `taa` MCP server, budget plugin |
| `managed/codex/requirements.toml` | `/etc/codex/requirements.toml` | MCP server allowlist; optional approval/sandbox guardrails |
| `managed/codex/managed_config.toml` | `/etc/codex/managed_config.toml` | Gateway provider, default model, `taa` MCP server; overrides user config at startup |
| `member/taa.env` | `~/.config/team-ai-allowance/env` (member, mode 0600) | Key and control URL; never installed by root |
| `mdm/*.mobileconfig` | MDM, macOS | `com.anthropic.claudecode`, `ai.opencode.managed`, `com.openai.codex` profiles |
| `install.txt` / `manifest.json` | bundle only | Install plan and machine-readable description |

All managed files are root-owned and mode 0644. `install.sh` prints every
target and asks before writing; `--yes` skips the prompt for automation. It
only accepts targets under `/etc`, refuses symlinks at the target path, and
verifies mode and ownership after each write.

## What each lock covers

### Claude Code

- `env.ANTHROPIC_BASE_URL` points every session at the gateway. A managed
  value beats user, project, local and `--settings` values.
- `allowedProviders: ["customEndpoint"]` refuses any other provider.
- `availableModels` replaces the user's allowlist, and `--model` can only
  pick from it. The managed default model is a default, not a lock.
- `managed-mcp.json` is the exclusive server set: only `taa mcp` loads, and a
  user's `--mcp-config` is refused.

Proven in the container: with a user `settings.json` pointing at another
gateway, and no shell copy of `ANTHROPIC_BASE_URL`, `claude -p` reached the
local mock gateway defined by the managed file and answered `OK`.

Still open: an administrator or root user can edit the managed file; MDM is
the stronger delivery path. The gateway key is not in the managed file, so it
must come from the member environment (a GUI launch may not inherit it).

### OpenCode 2

- `enabled_providers: ["<provider>"]` compiles to deny-all / allow-gateway
  policies for `provider.use`. A user's own provider entries cannot be used.
- The managed `model` selects the gateway model at startup.
- The managed `mcp.taa` entry registers the request desk and the `plugin`
  entry names `/etc/opencode/plugins/team-ai-allowance.ts`, where the
  drop-in build is copied.
- OpenCode 2 managed config outranks user, project, `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_CONTENT`.

Proven in the container: with a user config adding an `anthropic` provider and
a different model, `opencode models --standalone` listed only the two gateway
models; `opencode debug config` listed `/etc/opencode/opencode.json` as a
source and selected `team-gateway`.

Still open: OpenCode has no documented MCP allowlist in the managed file, so
a user may add another MCP server; the managed `taa` entry still wins by name.
Older 1.x clients use the same `enabled_providers` key but were not tested
here. A root user can edit the managed file.

### Codex

- `requirements.toml` is enforced: `[mcp_servers.taa]` is an allowlist, so an
  unapproved MCP server is disabled. Optional
  `allowed_approval_policies` / `allowed_sandbox_modes` narrow those choices.
- `managed_config.toml` sets the gateway provider, default model and `taa`
  MCP server. At startup it overrides the user's `config.toml` and CLI
  `--config` values.

Proven in the container: with a user `config.toml` setting another provider,
model and MCP server, `codex doctor` reported
`deepseek-v4.1-flash · team-gateway` and `disabled servers 1`, and the user's
server name did not appear.

Still open: a user can change `model`, sandbox and approval choices during a
run; the managed defaults apply again at the next start. Codex exposes no
model allowlist, so the per-key model list at the gateway is the real model
lock. `managed_config.toml` is a legacy mechanism: keep
`requirements.toml` for anything that must not change.

## macOS MDM templates

Each `.mobileconfig` wraps one managed-preferences payload:

| Profile | Domain | Contents |
| --- | --- | --- |
| `com.anthropic.claudecode.mobileconfig` | `com.anthropic.claudecode` | Same keys as `managed-settings.json` |
| `ai.opencode.managed.mobileconfig` | `ai.opencode.managed` | Same keys as `opencode.json` |
| `com.openai.codex.mobileconfig` | `com.openai.codex` | `config_toml_base64`, `requirements_toml_base64` |

The profiles carry no key. Test them on one Mac before a fleet rollout: an MDM
profile outranks the managed settings file in Claude Code, and the Codex MDM
payload is the highest-precedence managed defaults layer. They are templates,
not a proven macOS deployment.

## The member key

`member/taa.env` contains `ANTHROPIC_AUTH_TOKEN`, `TAA_MEMBER_KEY`,
`ANTHROPIC_BASE_URL` and `TAA_BASE_URL`, one line each, and is written mode
0600. The generator refuses a key that contains whitespace, quotes or shell
metacharacters, and refuses to emit any other file that contains it. Managed
files reference `{env:TAA_MEMBER_KEY}` (OpenCode) or `env_key =
"TAA_MEMBER_KEY"` (Codex) by name.

The file is plaintext. It protects against accidental copying, not against a
local user who can read the member's home. Rotate at the control service and
rewrite the file when a key is exposed.

## Container proof

`make lockdown-check` runs `deploy/managed/container-check.sh` in
`docker.io/library/node:24-alpine` through podman. It installs Claude Code
2.1.316, Codex 0.165.0 and OpenCode v2.2.5, generates a bundle, installs it
as root **inside the container**, and tries to override each client. It never
uses sudo and never writes a host path; the repository is mounted read-only.

Result on 2026-10-31: all four checks proven (OpenCode provider lock, Codex
managed config, Codex MCP allowlist, Claude managed base URL).

## Residual risk

These are the honest limits, not bugs to hide:

1. **Local admin rights beat every file.** A member who is root or an
   administrator can edit `/etc/...` or install another client. Managed files
   are not tamper-proof. Remedies: MDM with removal disallowed, device
   management, network egress rules, and policy.
2. **A private provider key bypasses the gateway.** Any member with their own
   OpenAI/Anthropic key can use it from a client outside this configuration.
   Only network rules and policy can stop that; see `SECURITY.md`.
3. **The gateway is the real budget and model lock.** Claude's
   `availableModels`, OpenCode's provider list and Codex's MCP allowlist narrow
   the client surface, but the per-key model list, budget and rate limits live
   at LiteLLM. A client that ignores managed config still cannot spend without
   a key the gateway accepts.
4. **Codex has no client-side model allowlist.** `managed_config.toml` is a
   startup default and the user can change the model mid-run. The gateway
   refuses models the key does not allow.
5. **OpenCode MCP servers are not allowlisted.** Provider use is locked;
   additional user MCP servers are possible. They still need the member key to
   spend, and the `taa` server name cannot be replaced by a user entry.
6. **Environment delivery is the weak link for GUI launches.** A terminal that
   sources the member env works; a desktop app launched outside that shell may
   not see `ANTHROPIC_AUTH_TOKEN` / `TAA_MEMBER_KEY`. Use MDM-delivered
   environment or a login-shell wrapper if that matters.
7. **The macOS templates are untested here.** They encode the documented
   domains and key shapes, but only the Linux files were exercised by a real
   client.
8. **Version drift.** The proof used OpenCode v2.2.5; the project notes were
   written against v2.1.3. Both are v2, but a future major change could alter
   policy or managed-file behaviour. Re-run `make lockdown-check` on upgrade.
