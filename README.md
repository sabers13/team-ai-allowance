# Team AI allowance

**How does a team share AI coding tools without surprise bills, and without
blocking people who need more?**

A team gateway holds the provider keys and enforces each member's models and
spend limits on every request. A manager console shows spend, sets limits and
decides requests. A request desk inside Claude Code, OpenCode and Codex lets a
member ask for more without leaving the terminal.

Live project showcase: <https://sabersojudi.com/team-ai-allowance/> ·
Source repository: <https://github.com/sabers13/team-ai-allowance>

## What it gives a team

- **Limits a member cannot switch off.** Model traffic goes through one team
  gateway that holds the provider keys. A member gets a personal gateway key;
  the gateway enforces that key's model list, budget and rate limits before
  every call, whatever the member changes on their own machine.
- **A manager console.** Spend per member and model, limits, model access, the
  request inbox, an append-only audit log and a usage report with CSV export.
- **A request desk inside the CLI.** The `taa` MCP server answers "how much do
  I have left?", files a budget or model request with a reason, and shows the
  decision. The manager approves, partly approves or denies, once or until a
  date.
- **Off-hours protection.** A watcher blocks a member's key when off-hours
  spend passes the team cap, which covers the "left it running over the
  weekend" case for every CLI.
- **Lock-down for three clients.** The setup pack generates managed
  configuration for Claude Code, OpenCode and Codex, plus macOS MDM templates.

## Quickstart

You need Node 24. The full stack also needs Podman or Docker with Compose.
Both paths listen on `127.0.0.1:18080`; run one at a time.

### The fast path (no containers)

```bash
make setup
make demo
```

`make demo` starts an in-process gateway mock and the control service, seeds
the demo organisation, and writes one-time credentials to
`var/demo-credentials.txt` (mode 0600, never printed). Open
<http://127.0.0.1:18080> and sign in as `priya@example.test` with the password
from that file. Stop it with Ctrl-C.

The seed is idempotent: a second run against an existing `var/demo.db` keeps
the old organisation and cannot re-issue its one-time passwords or keys.
Delete `var/demo.db` (and `var/demo-credentials.txt`) before a fresh demo run.
The in-process gateway mock charges a fixed amount per call, so the demo's
small budgets mean a handful of calls rather than a hundred thousand.

Try the member desk from the same shell:

```bash
export TAA_BASE_URL=http://127.0.0.1:18080
export TAA_MEMBER_KEY=<Lena's key from var/demo-credentials.txt>
node src/cli/index.ts status
```

Register the MCP desk in a CLI with `taa mcp` (see
[docs/MEMBER.md](docs/MEMBER.md)). In this repository, `taa` is
`node src/cli/index.ts`; run `npm link` to put the command on your `PATH`.

With Claude Code installed, this registers the desk against the checkout:

```bash
claude mcp add --transport stdio taa -- node "$PWD/src/cli/index.ts" mcp
```

Then ask the agent to call `my_allowance`, or call it from the tool picker.

### The full stack (Podman or Docker)

```bash
make stack-up      # LiteLLM, Postgres, control service, mail and webhook catchers
make stack-logs
make stack-down
```

The console is <http://127.0.0.1:18080>, the gateway
<http://127.0.0.1:14000>, Postgres `127.0.0.1:15432`, the mail catcher
<http://127.0.0.1:18025> and the webhook catcher
<http://127.0.0.1:18090>. `deploy/.env` is generated with random secrets, mode
0600, and is ignored by git. Every port binds loopback only. See
[deploy/README.md](deploy/README.md) and [docs/ADMIN.md](docs/ADMIN.md).

## Which CLIs were verified

Three CLIs were run against a real model through the local gateway in
November 2026. Each one answered, was refused a blocked model, exhausted a USD
0.05 test budget, filed a request through the real MCP desk, was approved
through the manager API, and worked again.

| CLI | Version tested | What the run proved | Gateway spend |
| --- | --- | --- | --- |
| Claude Code | 2.1.316 (Claude Code) | allowed call, 403 blocked model, 422 budget, MCP request, approval | USD 0.056733 |
| OpenCode | opencode v2.1.3 | allowed call, 403 blocked model, 422 budget, MCP request, approval | USD 0.058732 |
| Codex | codex-cli 0.165.0 | allowed call, 403 blocked model, 401 blocked key, MCP request, approval | USD 0.055337 |

The run used one real model, `deepseek-v4.1-flash`, served by LiteLLM in each
CLI's own wire format. The gateway spend above is test-denominated: the live
gateway used inflated test prices so a USD 0.05 budget would exhaust in a few
calls. Total gateway spend for the live check was USD 0.170827, and the
OpenCode plugin member spent USD 0.000025 while proving the unattended rule.
See `results/live.json`.

**Expected to work, untested in this release:** any other CLI that accepts a
custom Anthropic or OpenAI-compatible base URL and supports stdio MCP. The
request desk works in any MCP-capable client; enforcement works for any client
whose traffic goes through the gateway. Codex only speaks the Responses wire
format in 0.165.0; a client that speaks only Chat Completions or only
Anthropic Messages needs the matching gateway route. See
[docs/MEMBER.md](docs/MEMBER.md).

## Tested on a real AI agent crew

Four worker agents built small projects through the gateway while a manager
agent decided their requests. Limits were set tiny on purpose. The summary:
every budget, model and key limit that was actually reached did bite, and the
audit trail is complete for decisions and key state. Some expected events did
not happen as designed.

- Crew: 6 accounts, 11 requests, 69 audit events; Night: 3 accounts.
- 5 of 7 scripted probes passed.
- 317 of 369 gateway spend rows cost nothing — they carried 12,896,452 tokens
  between them. Total gateway spend was USD 0.082512; the probes cost USD
  0.022452.
- The streaming-cost defect meant the off-hours cap never fired for the Night
  member, and the first budget approval became a manual limit edit because
  metered spend hit the wall before a request could be filed.
- Request-created and request-decided notifications were never sent, expired
  grants were not audited, and the loop rule was not proven on a real agent
  (the unattended rule paused the session instead).

The full per-scenario record, timestamps, refusals, notifications and the
honest list of what went wrong are in `results/dogfood.json` and
`results/dogfood-probes.json`.

## Results and their files

| Result | Machine-readable file | Producer / reference |
| --- | --- | --- |
| Live check with the three real CLIs | `results/live.json` | `scripts/live-check.ts` |
| Team test with a real agent crew | `results/dogfood.json` | `scripts/dogfood/evidence.ts` |
| Scripted feature probes | `results/dogfood-probes.json` | `scripts/dogfood/probes.ts` |
| Console screenshots of the team-test state | `results/dogfood/` | `results/dogfood/screenshots.json` |
| Weekend simulation | `results/sim/*.json` | `make sim` (byte-identical) |
| Scripted demo screenshots | `results/demo/` | [results/demo/README.md](results/demo/README.md) |
| Published numbers | `project-facts.json` | `make facts` |

### Weekend simulation

One agent loops from Friday evening to Monday morning with no human message.
This is a simulation with a fake clock and example list prices, not a
measurement.

| Scenario | Stopped at | Spend at stop |
| --- | --- | --- |
| No limits | step 5000, Monday morning | USD 144.97 |
| Member budget only | step 740 | USD 21.03 |
| Off-hours cap only | step 289 | USD 8.03 |
| Budget, off-hours cap and plugin unattended rule | step 40 | USD 0.55 |

## LiteLLM: open source only

The gateway is LiteLLM, pinned to `v1.105.1` by digest. **This project uses
only LiteLLM's open-source features.** Per-key model lists, per-key budgets
with a duration, key block/unblock, spend logs and teams are all in the
open-source proxy. The audit log, manager/member roles, soft and hard
thresholds, grace, grants, off-hours caps and requests are built in this
repository, not bought. No LiteLLM Enterprise licence key is required or
included. [THIRD_PARTY.md](THIRD_PARTY.md) records the verified
open-source/enterprise split and the licence boundary.

## Limits, stated plainly

- **A determined member can bypass the gateway.** Someone with administrator
  rights on their own machine can edit managed files or install another
  client, and someone with a private provider key can spend outside the team
  account entirely. Device management, network egress rules and policy are the
  remedies; the gateway cannot see traffic that never reaches it. See
  [SECURITY.md](SECURITY.md).
- **Two enforcement speeds.** Gateway budgets and model lists are exact per
  request. Token caps, off-hours caps and threshold notices are near-real-time:
  within one watcher poll (30 seconds by default) plus requests already in
  flight.
- **Cost metering has a known defect.** Streamed worker-model calls were
  recorded with no cost in the team test. The gateway still refused calls
  once metered spend crossed the limit, but caps that depend on spend (the
  off-hours cap) did not fire on streamed traffic. Non-streaming metered calls
  price correctly.
- **Three team-test events were not exercised.** The team-test run did not prove
  the request-flow first approval (a manual limit patch preceded it), the
  cheaper-model hint (no hints file was imported), or the OpenCode loop rule
  (the unattended rule paused first). The demo flow covers the hint; the other
  two remain evidence gaps, not claims, in `results/dogfood.json`.
- **No single sign-on.** Version 1.0.0 has local accounts: manager passwords
  (scrypt) and member gateway keys. SSO and MFA are out of scope.
- **The control service keeps credentials and sessions in memory.** A restart
  signs everyone out, forgets manager passwords and invalidates manager API
  tokens. A bootstrap admin is recreated from `TAA_BOOTSTRAP_EMAIL` and
  `TAA_BOOTSTRAP_PASSWORD`; other accounts must be enrolled again.
- **The model catalogue has no management surface yet.** The catalogue is
  seeded with the demo organisation. Provision real entries before enrolling
  members (see [docs/ADMIN.md](docs/ADMIN.md)); a console form is future work.
- **The macOS MDM templates are untested.** The Linux managed files are proven
  in a container (`make lockdown-check`); the macOS profiles are templates.
- **No TLS is included.** Run the stack behind a reverse proxy with TLS before
  exposing it beyond loopback.

## Commands

```bash
make setup            # npm ci
make lint             # Biome
make typecheck        # tsc --noEmit, strict
make test             # node --test over test/**/*.test.ts
make e2e              # Playwright, localhost-only guard
make scan-forbidden   # hashed name guard
make scan-secrets     # credential-shaped string guard
make facts            # check project-facts.json and every README number against results/
make facts-write      # recompute the fact values from results/ before checking
make release-check    # all of the checks CI runs
```

`make stack-up`, `make stack-down`, `make stack-logs`, `make demo`, `make sim`,
`make live-check`, `make lockdown-check` and `make gateway-it` are described in
[docs/ADMIN.md](docs/ADMIN.md) and [deploy/README.md](deploy/README.md).

## Documentation

| File | Contents |
| --- | --- |
| [docs/ADMIN.md](docs/ADMIN.md) | deploy, teams, models, limits, rules, notifications, lock-down, backups |
| [docs/MEMBER.md](docs/MEMBER.md) | connect your CLI, check your allowance, ask for more |
| [SECURITY.md](SECURITY.md) | threat model, bypass routes, key handling, reporting a problem |
| [THIRD_PARTY.md](THIRD_PARTY.md) | dependencies, licences and the LiteLLM boundary |
| [CHANGELOG.md](CHANGELOG.md) | what version 1.0.0 contains |

## Layout

| Path | Contents |
| --- | --- |
| `docs/` | operator, lock-down and member guides |
| `src/contracts.ts` | frozen domain types |
| `src/core/`, `src/watcher/`, `src/notify/` | policy, reconciler, watcher and notifications |
| `src/api/`, `src/console/` | HTTP API, sessions, server-rendered console |
| `src/mcp/`, `src/cli/` | MCP member and manager desks, the `taa` command |
| `src/setup/`, `deploy/managed/` | setup pack, managed config, lock-down check |
| `src/plugin/` | optional OpenCode in-session rules |
| `src/sim/` | deterministic weekend simulation |
| `scripts/` | demo, live check, facts, name and secret guards |
| `results/` | every published number and its evidence |
| `test/`, `e2e/` | unit tests and browser tests |

## Licence

MIT License — see [LICENSE](LICENSE). Never commit a key or a prompt.
