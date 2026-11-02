# Member guide

You have a personal AI allowance: a gateway key with a budget, a model list
and (sometimes) rate limits. Your CLI talks to the team gateway instead of a
provider, so the limits apply wherever you work. This guide shows how to
connect, check what is left, and ask for more.

Your manager runs the console and decides requests. The operator guide is
[ADMIN.md](ADMIN.md).

## 1. What you receive

Your manager gives you two things, once:

- the **control-service URL** (for example `https://allowance.example.com`);
- your **gateway key**, a secret that starts with `sk-`.

The key is shown once. The server stores only its hash. Nobody can look it up
for you later; if you lose it, ask your manager to rotate it.

Treat the key like a password:

- never commit it, paste it into a chat, or put it in a command line;
- keep it in a file only you can read (mode 0600);
- use one key per person, never share a key between teammates.

## 2. Connect your CLI

Put the key and the control URL in your shell environment, ideally from a
mode-0600 file:

```bash
# ~/.config/team-ai-allowance/env  (mode 0600)
export TAA_BASE_URL=https://allowance.example.com
export TAA_MEMBER_KEY=sk-...
```

Then `source` that file from your shell profile. A desktop app launched
outside that shell may not see the variables; use your OS's environment
mechanism or the managed configuration from your administrator.

All three clients below were verified live in version 1.0.0. A different CLI
that accepts a custom Anthropic or OpenAI-compatible endpoint and stdio MCP is
expected to work.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://gateway.example.com
export ANTHROPIC_AUTH_TOKEN="$TAA_MEMBER_KEY"   # bearer form
```

Or put the same values in the `env` block of your settings file. Register the
request desk once:

```bash
claude mcp add --transport stdio taa -- taa mcp
```

Claude Code inherits your shell environment for the MCP child, so the key
stays in the environment file rather than in `.mcp.json`.

### OpenCode

Add a gateway provider and the MCP server to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "team-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Team gateway",
      "options": {
        "baseURL": "https://gateway.example.com/v1",
        "apiKey": "{env:TAA_MEMBER_KEY}"
      },
      "models": {
        "deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash" }
      }
    }
  },
  "model": "team-gateway/deepseek-v4.1-flash",
  "mcp": {
    "taa": {
      "type": "local",
      "command": ["taa", "mcp"],
      "environment": { "TAA_MEMBER_KEY": "{env:TAA_MEMBER_KEY}" },
      "enabled": true
    }
  }
}
```

The `models` map must match the model ids your gateway serves. The provider's
model picker is a display filter, not enforcement; the gateway enforces your
key's model list.

### Codex

In `~/.codex/config.toml`:

```toml
model = "deepseek-v4.1-flash"
model_provider = "team-gateway"

[model_providers.team-gateway]
name = "Team gateway"
base_url = "https://gateway.example.com/v1"
env_key = "TAA_MEMBER_KEY"
wire_api = "responses"

[mcp_servers.taa]
command = "taa"
args = ["mcp"]
```

`wire_api` is `responses` in Codex 0.165.0; the gateway must expose
`/v1/responses`. The MCP child inherits your environment; keep the key in the
environment file, not in `config.toml`.

### Any other MCP-capable client

Register a stdio server whose command is `taa mcp`. It reads `TAA_BASE_URL`
and `TAA_MEMBER_KEY` from the environment (or `TAA_MEMBER_KEY_FILE` with a
mode-0600 file). Nothing is sent anywhere except your control service.

If `taa` is not on your `PATH`, use the absolute path to the installed CLI, or
`node /path/to/team-ai-allowance/src/cli/index.ts mcp` from a source checkout.

## 3. Check your allowance

In the terminal:

```bash
taa status
taa status --json
```

Example answer:

```text
USD 1.90 left of USD 2.00 this period (5% used, ok limit). Allowed: mock-cheap.
```

Inside any connected CLI, call the tools from the client's tool picker, or ask
the agent to call them:

- `my_allowance`: remaining budget, status, reset time and allowed models.
- `allowed_models`: the model ids you may use right now.
- `my_requests`: your requests, newest first.
- `cancel_request`: withdraw a pending request.

You can also sign in to the console at `/login` with your gateway key. The
**My allowance** page shows your remaining budget, allowed models, a request
form and your request history.

Statuses:

| Status | Meaning |
| --- | --- |
| `ok` | Below the soft limit |
| `soft` | You passed the soft limit; a notice was sent. Keep working, but plan |
| `grace` | You are past 100% inside the grace band; calls may still work briefly |
| `blocked` | The gateway refuses. The reason names a budget, token cap, off-hours block or a manager's block |

Off-hours and token-cap blocks are applied by the watcher within one poll
interval (30 seconds by default) plus requests already in flight. The gateway
budget is exact on every request.

## 4. Ask for more

### More budget

```bash
taa request more-budget \
  --amount 10 \
  --reason "finishing the migration; two more days of work" \
  --until 2026-11-06
```

### A model unlock

```bash
taa request model deepseek-v4.1-pro \
  --hours 24 \
  --reason "the Unicode audit needs the stronger model"
```

### A suggestion

```bash
taa request suggestion "the daily period resets at midday for me; can we move it?"
```

The same actions are MCP tools: `request_more_budget`, `request_model` and
`send_suggestion`. The CLI form of the last one is `taa request suggestion`.

`--until` and `--hours` are recorded in your request message as a preference.
The manager decides the actual grant: once, until a date, or permanent.

### What your manager sees

The request card shows your name, the kind, the amount or model, your reason,
your spend this period against your limit, your top models and your spend over
the last seven days. For a model request, it may also show a cheaper model
that can do the job.

### After the decision

You are told the outcome and the note. An approved grant takes effect after
the reconciler applies the new key state; this can take up to five minutes.
A model grant has an expiry if the manager set one; after it expires, the
model is refused again.

If the answer is no, read the note. It often names the enabled model to use,
or asks you to finish with what you have. Do not file the same request again
without new information.

## 5. When a call is refused

| What you see | What it means | What to do |
| --- | --- | --- |
| `401` / "Key is blocked" | A hard limit, token cap, off-hours block or a manager's block | `taa status`; ask your manager; wait for the next period or working hours |
| `403` / "model ... is not available for this API key" | The model is not in your key's list | Use an allowed model, or file `request_model` |
| `422` / "Budget has been exceeded" | The gateway budget is spent | File `request_more_budget`, or finish with what you have |
| Connection or DNS error | Wrong control URL or gateway unreachable | Check `TAA_BASE_URL`; run `taa doctor` |
| The MCP desk is missing | The client did not start `taa mcp`, or the key is not in its environment | Check the client's MCP entry; restart the client |

`taa doctor` prints the installed CLI versions, whether each points at the
gateway, whether the `taa` MCP server is registered, and whether the control
service answers. It prints paths and hosts, never secrets.

## 6. Privacy and your data

The control service stores ids, timestamps, model ids, token counts, costs,
decisions and your request text. It does **not** store your prompts or the
model's responses; the gateway is configured not to write prompt text to its
spend logs.

Your request message is read by your manager and kept in the request and audit
history. Do not paste a secret, a credential or private prompt text into a
request reason.

## 7. Limits you should know about

- Your CLI can be reconfigured, but the gateway still enforces your key's
  models, budget and rate limits on every call. That is the lock.
- If you have administrator rights on your machine, you can edit managed
  files. Don't; it breaks the audit and the team's cost model.
- A private provider key or a personal account bypasses the team gateway
  entirely. The team cannot see or cap that spend. See
  [../SECURITY.md](../SECURITY.md).
- Single sign-on is not included in version 1.0.0.
