# Security

This document is the threat model for team-ai-allowance version 1.0.0, the
controls that exist, the bypass routes that remain, and how to report a
problem. It describes the product as built, not as intended.

The short version: the gateway is the real budget and model lock, but it can
only enforce traffic that reaches it. A member with administrator rights on
their own machine or a private provider key can step outside it. The remedies
are device management, network rules and policy, not a setting in this
repository.

## 1. What is protected

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Provider key | Gateway container environment only | Spends real money upstream |
| LiteLLM master key | Gateway and control-service environment | Full admin over keys, budgets and spend |
| Member gateway keys | Shown once; SHA-256 hash in the control database; the key itself in LiteLLM | A key spends as that member |
| Manager passwords | scrypt hash in memory | Console and manager API access |
| Manager API tokens | Shown once; SHA-256 hash in memory | Manager routes and MCP tools |
| Session and CSRF secrets | Control-service environment | Signing cookies and CSRF tokens |
| Spend, usage and request data | Control SQLite and LiteLLM Postgres | Cost attribution, decisions, personal data |
| Audit history | Control SQLite | Accountability for every change |
| Prompt and response text | **Not stored** by this project | Privacy |

## 2. Trust boundaries

```
member machine (untrusted)  ── gateway key ──►  LiteLLM gateway (trusted)
        │                                             │
        └── MCP desk ── member key ──► control service ◄┘
                                             ▲
manager browser (semi-trusted) ── session ───┘
                                             │
                              notifications ─┴─► Teams / Slack / SMTP / webhook
```

- The **member machine** is untrusted. Managed configuration narrows what the
  client can do, but a local administrator can change it.
- The **gateway** is trusted and holds the provider key. It enforces the
  per-key model list, budget and rate limits before every request.
- The **control service** is trusted. It holds the master key, decides policy,
  reconciles key state, runs the watcher and serves the console.
- The **manager browser** is semi-trusted. It authenticates with a session
  cookie and a per-session CSRF token.
- **Notification channels** are external. They receive ids, amounts, model
  names, dates and reasons, never prompt or response text.

## 3. Bypass routes and remedies

These are the honest limits. None of them is hidden behind a claim that the
gateway "always" wins.

| Bypass route | What happens | Remedy |
| --- | --- | --- |
| A member has root/admin on their own machine and edits `/etc/...` managed files | The client can be pointed elsewhere; the gateway still enforces any traffic that reaches it | MDM with removal disallowed, device management, endpoint policy; re-run `make lockdown-check` after client upgrades |
| A member uses a private provider key or personal account | The spend never reaches the team gateway and cannot be seen or capped | Network egress rules that allow only the gateway, device policy, employment/contract policy |
| A member shares a key with another person or machine | Both spend as the same member; the key-level budget and model list still cap the total, but attribution is lost | One key per person, rotation on suspicion, audit review; no per-request device identity |
| A member copies another member's key or the env file | They act as that member within that key's limits | File mode 0600, disk encryption, rotation, short-lived keys; no hardware binding |
| A client ignores managed configuration | It can still call the gateway only with a key the gateway accepts; the per-key list and budget apply | The gateway is the lock; do not rely on client-side lists |
| A member changes the model in Codex mid-run | Codex has no model allowlist in its managed config | The gateway refuses models the key does not allow |
| A member adds an MCP server in OpenCode | Provider use is locked, but additional MCP servers are possible | They still need the member key to spend; the managed `taa` entry wins by name |
| A member uses a different machine with the same key | The key works anywhere unless you add network controls | IP allowlists are not implemented in 1.0.0; rotate and use egress policy |
| A desktop app does not inherit the member environment | The CLI cannot authenticate, or falls back to another account | Deliver environment through MDM or a login-shell wrapper |
| A member removes the `taa` MCP server | The request desk is unavailable; the CLI cannot file or follow a request from inside the session | The gateway still enforces the key's model list, budget and block state; the member can use the console or ask the manager directly |
| A member removes the optional OpenCode plugin | Session budget, unattended and loop rules are not enforced in that session | The gateway budget and model list still hold; the watcher's off-hours and token caps still fire after a poll |
| A member runs several sessions in parallel | The gateway budget is per key and is shared, so total spend is still capped | Each plugin session keeps its own unattended counters, so the step limit can be multiplied across sessions; rotate or block the key if it is abusive |
| A member tries to mint a new key | Members have no key-minting route; only an admin can issue or rotate a key (`POST /api/admin/...`) | A leaked admin credential can mint one; keep admin tokens short-lived and audited |

What the gateway does enforce, for any client that uses a member key:

- the key's model list, before routing to a provider;
- the key's budget and budget duration, per request;
- rpm/tpm limits, when set;
- key block and unblock;
- spend rows that the watcher reads for token, off-hours and threshold rules.

## 4. Key handling

### Member keys

- The control service creates one LiteLLM key per member with the alias
  `taa-<memberId>`.
- The key is returned **once**, in the response that creates or rotates it.
  The control service stores only `sha256(secret)`; LiteLLM stores the key it
  needs.
- Authentication compares the hash with a timing-safe comparison.
- Rotation deletes the key and generates a replacement with the same alias and
  settings, because LiteLLM's `/key/regenerate` is an Enterprise-only route;
  the old key stops working immediately.
- The generated member environment file is mode 0600. It is plaintext: it
  protects against accidental copying, not against a local user who can read
  the member's home.
- A member key is refused on manager routes and tools. This is tested.

### Manager passwords and tokens

- Passwords are hashed with scrypt and a per-user salt; a failed login takes
  the same time whether or not the account exists.
- Login failures are limited per IP (10 failures per 15 minutes by default).
- Sessions last 12 hours; the cookie is `httpOnly`, `SameSite=Strict`, and
  `Secure` when `TAA_PUBLIC_URL` is HTTPS.
- Manager API tokens are shown once, stored as SHA-256 hashes in memory, and
  revoked when the member is deleted.
- **Passwords, tokens and sessions are memory-only.** A restart loses them.
  The bootstrap admin is recreated from `TAA_BOOTSTRAP_EMAIL` and
  `TAA_BOOTSTRAP_PASSWORD`; other accounts must be re-enrolled.

### Service secrets

- `LITELLM_MASTER_KEY`, the Postgres password, `TAA_SESSION_SECRET` and
  `TAA_CSRF_SECRET` live in `deploy/.env` (mode 0600, git-ignored) or the
  orchestrator's secret store.
- The provider key is read by the gateway container and is never opened,
  printed or copied by the test runners. The live check only checked that the
  file existed.
- Never put a secret on a command line, in a log, a test fixture or a commit.
  `make scan-secrets` is a guard, not a proof.

## 5. Roles and authorisation

- `admin`: every team; creates teams, managers and members; issues manager
  tokens.
- `manager`: their own team only; decisions, limits, models, keys, rules,
  audit and usage.
- `member`: their own allowance and requests.

The API enforces a minimum role per route and an object-level team check. A
member key cannot call a manager route or tool, and a manager cannot act on
another team; both are covered by tests. The console applies the same scope:
a member session is redirected to `/me`.

## 6. CSRF, sessions and the browser

- Every console form carries a per-session CSRF token; every mutating JSON API
  call authenticated by a session must send `x-csrf-token`.
- Mutating session requests are checked against `TAA_PUBLIC_URL` for origin.
- The session cookie is `httpOnly`, `SameSite=Strict`, signed with
  `TAA_SESSION_SECRET`, and expires after 12 hours.
- The member console login accepts the member's gateway key as the
  credential; the manager login accepts e-mail and password.
- **Known exception:** the console's sign-in form does not carry a CSRF token.
  The JSON `/login` route does; the console form relies on `SameSite=Strict`
  and uses the same per-IP failure limiter as the JSON route. The exposure is
  login CSRF, not session theft, and it is recorded for the release review
  rather than rounded down.
- There is no MFA and no SSO in 1.0.0.
- TLS is not included. Cookies are `Secure` only when `TAA_PUBLIC_URL` is
  HTTPS, so terminate TLS in a reverse proxy before exposing the console.

## 7. Audit

Every mutating manager and admin route that changes team, member, limit,
grant, key, rule or policy state writes an audit event with actor, action,
object, before, after and reason. The reconciler and watcher write their own
events. The API has no update or delete route for audit rows.

Known gaps, confirmed by the team test or the code:

- Audit is append-only through the API, not tamper-proof against an
  administrator who can write the SQLite file. Ship the log off-host if you
  need that property.
- Team deletion and member deletion audit the delete, but the gateway calls
  that revoke the keys are best-effort: a gateway outage can leave a key
  active until the next operator retry. The team delete route now revokes
  every member key before it deletes the team, and treats an already-missing
  key as deleted.

## 8. Privacy

- The control service stores ids, timestamps, model ids, token counts, costs,
  decisions and reasons. It never stores prompt or response text.
- LiteLLM is configured with `store_prompts_in_spend_logs: false`, and the
  setting is set explicitly in the gateway config.
- A member's request message is stored and shown to their manager; it is the
  member's own words, not model output. Do not put secrets or private prompt
  text in a request.
- Spend rows and backups contain metadata that can identify a person's work
  pattern (model, tokens, cost, time). Treat backups as personal data.
- The model provider still sees the prompts it is sent. This project cannot
  change a provider's retention; choose providers under your own agreement.

## 9. Residual risk

These are accepted for version 1.0.0:

1. **Host compromise.** An attacker with root on the control service or the
   gateway has every key and all data. Protect the host, the master key and
   the backups; run the pinned images; do not expose the gateway admin port.
2. **Private-key bypass.** The team cannot cap spend that never reaches the
   gateway. Only network and policy controls can.
3. **Local admin bypass.** Managed files are not tamper-proof. MDM and device
   management are stronger delivery paths.
4. **Memory-only credentials.** A restart loses passwords, tokens and
   sessions. This is an availability and operational risk, not a
   confidentiality one.
5. **Watcher lag.** Token and off-hours caps are near-real-time; a burst of
   in-flight requests can overshoot before the block lands. The gateway budget
   is exact.
6. **Streaming cost defect.** Streamed calls were recorded with no cost in the
   team test, so spend-based caps can undercount streamed traffic. Budget
   enforcement at the gateway still refused once metered spend crossed the
   limit.
7. **No MFA or SSO.** A stolen manager password is enough to act as that
   manager until the session or password is reset.
8. **No encryption at rest.** SQLite and Postgres are not encrypted by this
   project; use volume or disk encryption.
9. **Notification destinations are secrets.** A leaked webhook URL lets
   someone post into the team channel or read messages if the endpoint is
   public; rotate it in the environment.
10. **macOS templates are unproven.** They encode documented domains and key
    shapes but were not exercised on a Mac.

## 10. Reporting a problem

Do not open a public issue that contains a key, a token, a password, prompt
text or a member's personal data.

Use the repository's private vulnerability reporting (the **Security** tab on
GitHub) or a private message to the maintainer named in the repository
metadata.

A useful report includes:

- the version and commit you ran;
- what you did, what you expected, and what happened;
- the smallest reproduction you can give, with every secret and every prompt
  redacted;
- the impact you think it has.

If a key may have leaked:

1. Rotate that member's key in the console (**Member** page, **Rotate key**) or
   with `POST /api/team/members/:id/key/rotate`.
2. Revoke any manager token that may have leaked and issue a new one.
3. If a service secret leaked, rotate it in `deploy/.env`, restart the stack,
   and sign everyone in again.
4. Check the audit log and the gateway spend logs for use you cannot explain.

We aim to acknowledge a report, confirm the impact, and say whether a fix is
planned. This is a portfolio project, not a commercial support contract.
