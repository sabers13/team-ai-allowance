# Third-party software

Team-ai-allowance is MIT licensed (see [LICENSE](LICENSE)). It depends on the
software below. Versions are the ones pinned in `package-lock.json` and
`deploy/compose.yaml` at version 1.0.0.

## Runtime libraries (installed by `npm ci`)

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 2.4.0 | Apache-2.0 | The stdio MCP request desk |
| `@modelcontextprotocol/core` | 2.4.0 | Apache-2.0 | Transitive dependency of the MCP server |
| `zod` | 4.6.7 | MIT | Argument and configuration validation |

The control service, console, gateway client, watcher and simulation also use
Node.js built-in modules only. Node.js 24 is MIT licensed and is not vendored.

## Development and test libraries

These are not part of a production deployment.

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| `@biomejs/biome` | 2.6.4 | MIT OR Apache-2.0 | Lint and format |
| `typescript` | 7.0.2 | Apache-2.0 | Type checking (Node runs the TypeScript sources directly) |
| `@playwright/test` | 1.64.1 | Apache-2.0 | Browser tests |
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 | Accessibility checks |
| `axe-core` (transitive) | 4.14.0 | MPL-2.0 | Accessibility engine |
| `@types/node` | 26.6.6 | MIT | Node type definitions |

The lockfile contains 42 packages in total. Every one is MIT, Apache-2.0,
MPL-2.0, or MIT OR Apache-2.0. There is no GPL, AGPL or SSPL dependency. The
MPL-2.0 packages are used unmodified as development dependencies; MPL-2.0 is
file-level copyleft and does not reach this project's source.

## Services and container images

| Component | Image / version | Licence | Role |
| --- | --- | --- | --- |
| LiteLLM proxy | `ghcr.io/berriai/litellm:v1.105.1`, pinned by digest | MIT for the open-source proxy; enterprise code under commercial terms (see below) | The team gateway |
| PostgreSQL | `docker.io/library/postgres:17-alpine` | PostgreSQL License | LiteLLM keys, teams and spend rows |
| MailHog | `docker.io/mailhog/mailhog:v1.0.1` | MIT | Development SMTP catcher |
| Node.js image | `docker.io/library/node:24-alpine` | MIT | Control service, mock upstream and webhook catcher |
| Podman or Docker | your installed version | Apache-2.0 / Apache-2.0 | Container runtime, not distributed here |

The mock upstream, the webhook catcher and the mail catcher are development
aids. Do not expose them to the internet.

## The LiteLLM licence boundary

**LiteLLM is the only dependency path whose overall licence is not wholly
permissive.** The open-source proxy is MIT licensed. The same image also
contains enterprise-gated code that is licensed separately by BerriAI; that
code is not MIT.

This project uses only the open-source surface. The routes it calls — per-key
model lists, per-key budgets with a duration, key block/unblock/regenerate,
spend logs, teams and users — are in the open-source files at the pinned tag.
The audit log, roles, thresholds, grace, grants, off-hours caps and requests
are implemented in this repository. No Enterprise licence key is required,
included or configured, and no Enterprise feature is enabled.

If you enable an Enterprise feature, you need a commercial licence from
BerriAI. That is outside this project's MIT licence and outside the scope of
version 1.0.0.

The gateway image is pinned by tag and digest in `deploy/compose.yaml`. The
tag can move; the digest cannot.

## External services

The project talks to these only when you configure them; none is bundled:

- **Model providers** (the live check used an OpenAI-compatible endpoint).
  Their terms, data-retention rules and prices apply to the prompts sent
  through the gateway. This project stores no prompt or response text, but the
  provider still receives it.
- **Microsoft Teams, Slack and SMTP** for notifications. Notification bodies
  contain ids, amounts, model names, dates and reasons, never prompt text.
- **MailHog and the JSON webhook catcher** in the local stack are local test
  stand-ins for those channels.

## What is not third-party

The domain model, policy math, reconciler, watcher, notifications, HTTP API,
console, MCP tools, CLI, setup pack, lock-down check, OpenCode plugin,
simulation, demo and facts check are original code in this repository under
the MIT licence. `docs/` records the operator guides and the verified
external facts.
