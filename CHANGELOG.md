# Changelog

All notable changes to team-ai-allowance. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-11-02

The first public release (`v1.0.0`).

### Added

- **Gateway enforcement.** A LiteLLM gateway holds the provider keys and
  enforces each member key's model list, budget, budget period and rpm/tpm
  limits before every request.
- **Policy and reconciliation.** A pure policy function computes the effective
  budget, token cap, model list and status per member; an idempotent reconciler
  applies only the difference to the gateway key after every change and every
  five minutes.
- **Watcher.** Spend polling every 30 seconds, token caps, the off-hours spend
  cap, soft/grace/hard threshold notices and unusual-spend alerts, with a
  notification dedupe key per period.
- **Manager console.** Server-rendered Overview, Requests, Member, Models,
  Rules, Audit, Setup, My allowance and Usage pages; light and dark; responsive
  to 360 px; works without JavaScript for approvals, denials and filtering.
- **Requests and grants.** Budget, model and suggestion requests with automatic
  context; approve, partly approve, deny, cancel and expire; budget, model and
  token-cap grants with one-time, dated or permanent scope.
- **Auto-approve rules.** Budget top-ups and temporary model unlocks, decided
  and audited as the rule.
- **Member and manager MCP desks.** `taa mcp` serves the frozen member and
  manager tool sets over stdio, with short terminal text and structured
  content.
- **`taa` CLI.** `status`, `request`, `requests`, `decide`, `block`, `unblock`,
  `audit`, `doctor`, `hints import`, `serve` and `sim`.
- **HTTP API and authentication.** Member keys by SHA-256 hash, manager
  passwords with scrypt, 12-hour sessions, per-session CSRF tokens, role and
  team checks, login rate limiting, and an append-only audit trail.
- **Notifications.** Teams Workflows (Adaptive Card), Slack, SMTP, a generic
  JSON webhook and the always-on log channel.
- **Setup pack and lock-down.** Managed configuration for Claude Code,
  OpenCode and Codex, a mode-0600 member environment file, macOS MDM
  templates, a root-only Linux installer and a container proof
  (`make lockdown-check`).
- **OpenCode plugin.** Session budget notices, an unattended rule and a loop
  rule, with a v2 adapter for the installed OpenCode runtime.
- **Deterministic weekend simulation.** Four scenarios with a fake clock, real
  policy and cap functions, byte-identical output.
- **Scripted demo.** A walkthrough through gateway, console, MCP request,
  partial approval, denial, off-hours block, unblock, audit and usage, with
  screenshots.
- **Evidence and facts.** A live check with three real CLIs, a team test with a
  real agent crew, scripted probes, and a facts check that recomputes every
  published number from `results/`.
- **Documentation.** README, admin guide, member guide, security and threat
  model, third-party licences, changelog and the project-facts file.

### Verified

- **Live check.** Claude Code 2.1.316, OpenCode v2.1.3 and Codex 0.165.0 each
  answered on the allowed model, were refused a blocked model, exhausted a
  USD 0.05 test budget, filed a request through the real MCP desk, were
  approved through the manager API and worked again. Total gateway spend was
  USD 0.170827 at test-denominated prices. The OpenCode plugin stopped a
  looping task with its unattended rule.
- **Team test.** A manager agent and four worker agents used the gateway with
  limits set tiny on purpose. Every budget, model and key limit that was
  actually reached bit, and decisions and key state are audited. Total gateway
  spend was USD 0.082512; 5 of 7 scripted probes passed.
- **Simulation.** The same weekend loop cost USD 144.97 with no limits and USD
  0.55 with the budget, off-hours cap and plugin rule.
- **Quality gates.** `make release-check` (Biome, strict TypeScript, unit
  tests, name guard, secret scan, facts and licence) is green. `make e2e` is
  the Playwright suite for the demo flow.

### Fixed before release

Pre-release review found seven blockers; all were fixed before this
release, each with a regression test:

- Console forms now check the object's team, and the control service refuses a
  manager who acts on another team.
- Members can sign in to the console with their gateway key and reach My
  allowance.
- The reachable console login uses the per-IP failure limiter and does the same
  scrypt work for an unknown account.
- A team's gateway id is persisted, and a team budget change is pushed to the
  gateway, so a restart no longer creates a duplicate team with a fresh
  ceiling.
- Deleting a team revokes its member keys and deletes its gateway team.
- Request-created and request-decided notifications are sent and audited.
- `expireDue()` runs on a timer, so pending requests expire and grants write
  `grant.expired`.
- Also fixed: deleting a member whose key is already gone (HTTP 500), the
  member page showing "Active" for a spend-blocked key, the member audit card,
  invisible notification audit rows, unaudited manager tokens, grant revoke in
  the console and API, manager enrolment into their own team, key hashes in
  audit payloads and live evidence, the floored ceiling in the status, the
  console time zone, and the security, admin and interface text that
  overstated a control.

### Known issues

- Streamed worker-model calls were recorded with no cost: 317 of 369 gateway
  spend rows, carrying 12,896,452 tokens. Spend-based caps can undercount
  streamed traffic; the off-hours cap did not fire for the Night member in the
  team test.
- The first budget approval in the team test became a manual limit edit
  because metered spend reached the hard wall before a request could be filed.
- The loop rule was not proven on a real agent; the unattended rule paused the
  session instead.
- The Night off-hours scenario did not run because the off-hours cap never
  fired.
- The catalogue prices and gateway prices can differ; gateway spend is
  authoritative.
- The model catalogue has no console or API management surface; it is seeded
  with the demo organisation.
- Passwords, manager API tokens and sessions are memory-only, so a restart
  loses them.
- The console sign-in form has no CSRF token; the JSON login route does. See
  `SECURITY.md`.
- The macOS MDM profiles are templates and are not proven on a Mac.
- Single sign-on, MFA, TLS termination and IP allowlists are not included.
- The restore check against the orchestrator and global CLI config snapshots
  has no recorded before-test snapshot (`results/dogfood/cleanup.json` covers
  the stack, keys, teams and key files only).

### Security

- No prompt or response text is stored or logged; LiteLLM is configured with
  `store_prompts_in_spend_logs: false`.
- Member keys and manager tokens are stored as hashes and shown once.
- Manager passwords use scrypt with a per-user salt.
- The gateway is the real budget and model lock; client-side managed
  configuration is defence in depth, not the enforcement point.
- A member with administrator rights or a private provider key can bypass the
  gateway. The remedies are device management, network egress rules and
  policy; see `SECURITY.md`.
- Only LiteLLM's open-source features are used. No Enterprise licence key is
  required or included.
