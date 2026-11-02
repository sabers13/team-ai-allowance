# Admin guide

This is the operator's guide for a team-ai-allowance deployment: what runs,
how to enrol people, how limits and rules work, how to lock clients down, and
what to back up. The member-facing side is [MEMBER.md](MEMBER.md); the threat
model is [../SECURITY.md](../SECURITY.md).

## 1. What runs

The stack has six parts. In the demo, the gateway mock replaces the first two.

| Part | Default address | Purpose |
| --- | --- | --- |
| LiteLLM gateway | `127.0.0.1:14000` | Holds the provider key; enforces each member key's models, budget and rate limits |
| Postgres | `127.0.0.1:15432` | LiteLLM's keys, teams and spend rows |
| Control service (`taa serve`) | `127.0.0.1:18080` | API, console, reconciler, watcher, SQLite database |
| Mail catcher | `127.0.0.1:18025` | Development SMTP inbox (MailHog) |
| Webhook catcher | `127.0.0.1:18090` | Development JSON notification sink |
| Gateway mock | `127.0.0.1:14001` | Fake model provider for tests and the demo |

Every published port binds loopback. Put a reverse proxy with TLS in front of
the console before exposing it; the service sets `Secure` on cookies when
`TAA_PUBLIC_URL` is `https`.

The control service is the source of truth for teams, members, limits, grants,
requests, rules and audit history. The reconciler pushes the desired state to
LiteLLM; the watcher reads spend back and applies the caps LiteLLM cannot
express.

## 2. First start

### Prerequisites

- Node 24 for the in-process demo and for the checks.
- Podman or Docker with Compose for the full stack.
- A provider key for the model you will serve (the live check used an
  OpenAI-compatible endpoint).

### Secrets and the environment

`deploy/stack.sh` creates `deploy/.env` on first use with mode 0600 and random
values, and never prints them. It contains the Postgres password, the LiteLLM
master key, the session and CSRF secrets, and the demo manager password.

For anything beyond a throwaway local demo, set these as well:

| Variable | Why |
| --- | --- |
| `TAA_PUBLIC_URL` | Absolute external URL; used for links and the Origin check. Must be `https` in production. |
| `TAA_BOOTSTRAP_EMAIL`, `TAA_BOOTSTRAP_PASSWORD` | A stable admin login that survives restarts. The password must be at least 12 characters. |
| `TAA_TEAMS_WEBHOOK`, `TAA_SLACK_WEBHOOK`, `TAA_SMTP_URL`, `TAA_GENERIC_WEBHOOK` | Notification destinations. Never put these in git. |
| `TAA_WATCH_INTERVAL_MS`, `TAA_RECONCILE_INTERVAL_MS` | Poll and reconcile cadence. Defaults: 30 seconds and 5 minutes. |

`deploy/compose.yaml` forwards a fixed list of variables. To use your own
bootstrap admin in the container stack, add `TAA_BOOTSTRAP_EMAIL` and
`TAA_BOOTSTRAP_PASSWORD` to the `control` service's `environment` block (or run
`taa serve` directly with them exported).

**The control service keeps password hashes, manager API tokens and sessions in
memory.** A restart signs everyone out and forgets every manager password and
token. The bootstrap admin is recreated from `TAA_BOOTSTRAP_*`; other manager
accounts must be enrolled again and their tokens reissued. This is a release
1.0.0 limitation, not a setting.

### Start it

```bash
make stack-up          # build and start; first run builds taa-control:local
make stack-logs        # last 200 lines
make stack-down        # stop and remove containers and volumes
```

`TAA_STACK_BUILD=1 make stack-up` forces a rebuild after source changes.
`TAA_KEEP_DATA=1 make stack-down` keeps the volumes.

Health is `GET /health` on the console port. It reports the service, the
database schema version and gateway reachability.

### The in-process demo

`make demo` needs no containers. It seeds the demo organisation (manager
Priya, members Lena, Omar and Jonas, three mock models), starts the mock
gateway and `taa serve`, and writes one-time credentials to
`var/demo-credentials.txt` (mode 0600). Use it to try the product; it is not a
deployment.

The seed is idempotent and does not re-issue credentials on a second run.
Delete `var/demo.db` and `var/demo-credentials.txt` before starting a fresh
demo.

### A real organisation

Version 1.0.0 has no empty-start mode. The start path that creates the
bootstrap admin also runs the demo seed: the `Platform` team and its sample
accounts exist even when `TAA_STACK_DEMO_SEED=0`, which only suppresses the
demo manager login. The practical setup is:

1. Set `TAA_BOOTSTRAP_EMAIL` and `TAA_BOOTSTRAP_PASSWORD` so you keep an admin
   login across restarts.
2. Start the stack and sign in at `/login` with the bootstrap admin.
3. Create your own teams and managers through the admin API (section 3).
4. Delete the sample members you do not want from `Platform` and adjust that
   team's budget. Keep the team itself: it holds the bootstrap admin, and the
   next start would recreate the demo organisation if the team were gone.
5. Provision the model catalogue (section 4) before enrolling members.
6. Enrol members, hand each one the key once, and install the lock-down pack
   if the team wants it (section 8).

A first-class organisation bootstrap (an empty start with only your admin) is
future work. The demo seed is also why the sample names appear in a fresh
database; they are not product accounts.

## 3. Teams and accounts

### Roles

| Role | Sees | Can |
| --- | --- | --- |
| `admin` | Every team | Create/delete teams, create managers and members, issue manager tokens, read any team's data |
| `manager` | Their own team only | Decide requests, change limits and models, block/unblock/rotate keys, edit rules and policy, read audit and usage |
| `member` | Their own allowance and requests | Use their gateway key, file and cancel requests, read their usage |

A member key cannot call a manager route or tool, and a manager cannot act on
another team. Both are tested (`test/api`, `test/cli`).

### Create a team and accounts

The console's **Setup** page enrols a member, issues the gateway key once and
offers a per-CLI config bundle download. That is the normal path for members.

For teams and manager accounts, use the admin API. The console login is a form
login; the session cookie it sets authenticates the JSON API, and
`GET /api/session` returns the CSRF token that every mutating API call must
echo.

```bash
BASE=http://127.0.0.1:18080
# The password is read from a mode-0600 file, not written into the command.
curl -sS -c jar -o /dev/null -X POST "$BASE/login" \
  --data-urlencode "email=$TAA_ADMIN_EMAIL" \
  --data-urlencode "password@$TAA_ADMIN_PASSWORD_FILE"

CSRF=$(curl -sS -b jar "$BASE/api/session" \
  | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).csrfToken')

curl -sS -b jar -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"name":"Platform","monthlyBudgetUsd":120}' \
  "$BASE/api/admin/teams"
```

Creating a member returns `{member, secret}`. The `secret` is the member's
gateway key and is shown once; the control service stores only its SHA-256
hash. A manager or admin account also needs `email` and a password of at least
12 characters. A member signs in to the console with their key, not a
password.

Manager API tokens
for MCP and the `taa` CLI are issued with `POST
/api/admin/manager-tokens` (body `{memberId, label}`); the token is shown once
and stored hashed.

### Delete safely

Deleting a member asks the gateway to delete its key and then removes the
control-service rows. A key that is already gone is treated as deleted, so a
second cleanup pass succeeds rather than returning HTTP 500.

Deleting a team revokes every member's gateway key, deletes the LiteLLM team
and its stored gateway id, and then removes the control-service team and
members. If the gateway is unavailable the delete stops and can be retried;
keys are not left behind by a successful delete.

## 4. Models and the catalogue

The catalogue is the team's list of served models. Each entry has:

- `id`: the model name a client asks for;
- `displayName`;
- `route`: the LiteLLM upstream route;
- `inputPer1MUsd`, `outputPer1MUsd`: published prices for the console;
- `state`: `enabled`, `approval-required` or `blocked`;
- `sortOrder`.

The effective model list for a member is:

1. every catalogue entry in state `enabled`;
2. narrowed by the member's own model selection when that selection is not
   empty;
3. plus every model in an active model grant.

A model in state `approval-required` is included only while a grant is active.
A model in state `blocked` is never included, even with a grant. LiteLLM
enforces the resulting list per key on every request.

**Catalogue prices are display values, not enforcement.** Money is whatever
the gateway's configured prices produce. The team test found a 10x difference
between the catalogue and gateway prices; use the gateway figures for spend
reports.

**The catalogue is global to the control service.** It has no team column, so
every team sees the same entries. A future release may make it per team.

**Release 1.0.0 has no console form or REST route for adding catalogue
entries.** The catalogue is seeded with the demo organisation. To run a custom
catalogue, provision the entries before enrolling members, in the same way
`src/server/demo.ts` does with the store's `upsertModel`, and do not edit the
SQLite file by hand. A management surface is future work.

## 5. Limits and thresholds

### Member limits

| Limit | Where enforced | Notes |
| --- | --- | --- |
| Budget per period | Gateway, per key | Period is `daily`, `weekly` or `monthly`; sent as `1d`, `7d` or `30d` |
| Token cap per period | Watcher | Near-real-time; blocks the key when the period count passes the cap |
| Requests per minute (rpm), tokens per minute (tpm) | Gateway | Optional |

The key's gateway ceiling is the effective budget plus the grace share,
rounded **down** to whole cents. A USD 0.02 budget with 5% grace becomes USD
0.02, not USD 0.021: the grace band disappears on cent-sized budgets. Plan
limits with that rounding in mind.

### Team budget

The team's monthly budget is created on the LiteLLM team. It is a second
ceiling above the member keys.

### Thresholds and status

| Share of the effective budget | Status | What happens |
| --- | --- | --- |
| Below 80% (default) | `ok` | Nothing |
| At or above 80% | `soft` | A soft-limit notice to the member |
| At or above 100% | `grace` | A grace notice; calls still work inside the grace band |
| At or above 100% plus 5% (default) | `blocked` | The gateway refuses; the key is blocked |

`softRatio` and `graceRatio` are editable per team on the **Rules** page. The
gateway budget is exact per request. The watcher's token and off-hours caps
are near-real-time: within one poll interval plus requests already in flight.

### Off-hours cap

Working hours default to Monday–Friday 07:00–19:00 `Europe/Berlin`, with an
optional holiday list. When a member's off-hours spend since the last
working-hours boundary passes the cap (default USD 5), the watcher blocks
their key until the next working-hours start, or until a manager unblocks it.
Both the member and the manager are alerted.

A manager's unblock holds for that off-hours stretch only; the next stretch
blocks again if the cap is crossed.

## 6. Requests, grants and rules

### The request lifecycle

A member files `more_budget`, `model_unlock` or `suggestion`. The control
service attaches context automatically: spend this period, the limit, top
models and the last seven days. The member never sends spend or limit values.

States: `pending` → `approved` | `partly_approved` | `denied` | `expired`
(after 72 hours) | `cancelled` (by the member). The control service checks
both expiries on a timer, so a request becomes `expired` and a grant is
audited as `grant.expired` without a manager opening the console.

A decision records the manager, the note and the grant. A grant is one-time,
until a date, or permanent, and can be revoked from the **Member** page or
with `POST /api/team/grants/:id/revoke` (body `{reason}`). Budget grants add to
the current period; model grants open an `approval-required` model; token-cap
grants raise the cap. The reconciler applies the new key state after the
decision and every reconcile interval, so the member may need up to five
minutes before the gateway sees a grant.

### Auto-approve rules

Rules are per team and each rule has one condition:

- **Budget top-up:** at most `maxUsd`, at most once every `oncePerDays` days.
- **Model unlock:** unlock `modelIds` for `durationHours`.

The first enabled matching rule decides; the audit names the rule as the
actor. A manager can still revoke the resulting grant. Rules are edited on the
**Rules** page. The decision note shows which rule matched.

### The inbox

The **Requests** page is the manager inbox. Approve fully, approve partly with
an amount or a shorter duration, or deny with a note. The history tab keeps
decided, cancelled and expired requests. The **Member** page shows active
grants with their expiry.

## 7. Notifications

Channels are configured by environment variables and enabled per team on the
**Rules** page:

- **Teams:** a Workflows webhook callback URL, sent an Adaptive Card.
- **Slack:** an incoming webhook URL.
- **E-mail:** an SMTP URL and a from/to address.
- **Generic webhook:** any JSON endpoint.
- **Log:** always written; a failed channel never blocks a decision.

Destinations are secrets: keep them in `deploy/.env` or your orchestrator's
secret store, never in git.

Release 1.0.0 sends soft-limit, grace, hard-limit, blocked-member and
unusual-spend notices. **Request-created and request-decided notices are not
sent**: the request flow creates and decides requests without calling the
notifier. The team test confirmed this on both the webhook and the mail
catcher. Delivered notices are written to the audit table with a NULL
`team_id`, so the team audit API does not return them; the notification
catcher is the evidence source.

## 8. Lock-down

The setup pack generates managed configuration for Claude Code, OpenCode and
Codex, a member environment file, macOS MDM templates and an install plan.

From the console, the **Setup** page downloads a per-member bundle. From the
repository:

```bash
TAA_MEMBER_KEY_FILE=/secure/member-key \
  node src/setup/cli.ts --spec deploy/managed/example-setup.json --out /tmp/bundle
```

The key is read from `TAA_MEMBER_KEY` or a mode-0600 file, never from an
argument. Install the managed files as root on Linux:

```bash
sh deploy/managed/install.sh /tmp/bundle --dry-run   # show the plan
sudo sh deploy/managed/install.sh /tmp/bundle        # write /etc/...
```

The script refuses targets outside `/etc` and refuses symlinks. It never
installs the member environment file; that one belongs in the member's home
with mode 0600.

What is locked, and what is not, is in `docs/LOCKDOWN.md`. The short version:
the gateway is the real budget and model lock; managed files narrow the client
surface. A local administrator can edit `/etc`, and a member with a private
provider key can bypass the gateway entirely. The macOS profiles are templates
and are not proven on a Mac.

Prove the Linux lock-down in a disposable container:

```bash
make lockdown-check
```

It installs the three CLIs and the generated managed files inside the
container and shows user-level overrides being ignored. It uses no host root.

## 9. Backups, restore and restarts

### What to back up

| Item | Where | Why |
| --- | --- | --- |
| Control SQLite database | volume `taa-control-data`, file `/data/taa.db` | Teams, members, limits, grants, requests, rules, usage rows, audit |
| Postgres data | volume `taa-postgres-data` | Gateway keys, teams, budgets and spend-log rows |
| `deploy/.env` | repository host, mode 0600 | Master key, database password, session/CSRF secrets, demo password |
| Your provider key | your secret store, never the repository | The gateway needs it at start |

Do not back up `var/demo.db` as production data; it is a demo artefact.
Back up the two volumes together: the control database references gateway key
aliases, and a restore of only one side leaves keys or members dangling.

### Restore

1. Stop the stack (`make stack-down` with `TAA_KEEP_DATA=1`, or stop the
   services).
2. Restore both volumes and `deploy/.env` with their original ownership and
   modes.
3. Start the stack. The reconciler re-applies desired key state from the
   control database; the watcher resumes from its last poll.
4. Recreate memory-only state: the bootstrap admin is recreated from
   `TAA_BOOTSTRAP_*`; manager passwords and API tokens must be reissued;
   everyone signs in again.

A backup contains spend metadata (member ids, model ids, tokens, costs and
request text), not model prompts or responses. Treat it as personal data.

### Restart behaviour

Sessions, password hashes and manager tokens are in memory. A restart:

- signs every browser session out;
- loses every manager password except the bootstrap admin;
- invalidates every manager API token.

Member gateway keys are not affected: they live in LiteLLM and the control
service stores their hashes. Members can keep using their CLIs across a
control-service restart.

## 10. Day-two operations

- **Health:** `GET /health` reports the service, schema version, watcher and
  reconciler intervals, and gateway reachability.
- **Logs:** the control service writes one line per state change and per
  mutation, with ids and routes, never a body or a credential. `make
  stack-logs` shows the last 200 lines.
- **Reconcile drift:** the reconciler runs after every change and on its
  interval. If a key looks wrong, wait one interval, then check the audit for
  `key.state_applied` and the gateway's `/key/info`.
- **Rotate a member key:** use the member page or `POST
  /api/team/members/:id/key/rotate`. The new secret is shown once; the old key
  stops working.
- **Block or unblock a key:** member page, or the key block/unblock routes.
  A block is audited with its reason.
- **Rotate service secrets:** changing `TAA_SESSION_SECRET` or
  `TAA_CSRF_SECRET` signs everyone out. Changing `LITELLM_MASTER_KEY` requires
  the same value in LiteLLM and the control service; changing
  `POSTGRES_PASSWORD` requires a matching database. Do one at a time and keep
  a backup.
- **Upgrade:** pin a new LiteLLM tag and digest in `deploy/compose.yaml`, run
  `make release-check`, then `TAA_STACK_BUILD=1 make stack-up`. Re-run
  `make gateway-it` and `make lockdown-check` after a gateway or CLI upgrade.
- **Usage:** the **Usage** page reports a chosen period with a per-member
  table, the inferred CLI, a daily chart and a CSV download. The CLI is
  inferred from the wire format (Anthropic Messages, Responses, Chat
  Completions) and is labelled "inferred", never observed.

## 11. Reproducing the evidence

The committed evidence is not regenerated by `make release-check`; these
commands do it when you want fresh numbers.

- `make demo` starts the seeded demo and the scripted screenshots come from
  `make e2e`. Both are free and local.
- `make sim` regenerates `results/sim/*.json` deterministically. It calls the
  real policy and cap functions with a fake clock and makes no model call.
- `make gateway-it` starts the stack, runs the gateway integration check and
  tears it down. `TAA_KEEP_STACK=1` keeps it running.
- `make live-check` makes **real model calls and spends real money**. It reads
  the provider key from a mode-0600 environment file, runs each CLI in an
  isolated temp home, writes `results/live.json`, and restores every test key
  and team afterwards. Do not run it on a shared account without approval.
- The team test is the `scripts/dogfood/` pipeline with its own
  stack, teams and scratch repositories. Its machine-readable summary is
  `results/dogfood.json`.

Never edit a file under `results/` by hand. Re-run the producer; then run
`make facts-write` and `make facts` so the published numbers move with the
evidence.

## 12. What version 1.0.0 does not do

- No single sign-on and no MFA; local passwords and gateway keys only.
- No console page for creating teams, editing the model catalogue or managing
  notification destinations; use the admin API and environment.
- No durable credential store: passwords, manager tokens and sessions are
  memory-only.
- No TLS terminator and no reverse-proxy configuration; run it behind one.
- No macOS MDM proof; the profiles are templates.
- No exact enforcement of watcher caps; they are near-real-time by design.
- No protection against a member who bypasses the gateway with a private key
  or edits managed files as root. See [../SECURITY.md](../SECURITY.md).
