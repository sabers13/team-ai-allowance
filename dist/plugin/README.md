# Team AI Allowance: OpenCode in-session plugin

`team-ai-allowance.ts` is a single drop-in OpenCode server plugin. It enforces
the session rules that the gateway cannot see: budget notices and a hard stop,
the unattended rule, and loop detection. It stores nothing a person typed.

Status: **generated and unit-tested, not yet proven inside the live CLI.** The
control-service routes it prefers (`/api/me/session-policy` and
`/api/me/session-events`) are not on `main` yet; until they land, the plugin
derives its budget from the existing `GET /api/me` and keeps built-in
unattended/loop defaults. Do not claim in-session enforcement on the README or
project page until the routes exist and a live check has run.

## OpenCode 2.x loading (verified 2026-11-01 against OpenCode 2.1.3)

OpenCode 2 loads file plugins **only** from the plugin directories above (the
`plugin` config key is npm packages only) and requires the default export to
be a definition `{ id, setup }`. This file exports exactly that; the legacy
`server` Hooks export is kept for tests and older hosts but is not loaded by
OpenCode 2. The v2 adapter wires the same rule engine to
`tool.hook("execute.before"/"execute.after")`, pauses with the same messages,
and stops the run via `session.interrupt`, verified in the live check.

v2 limits (OpenCode 2 exposes no human-message or per-message-cost signal to
file plugins): step/loop/error counts are per session (no mid-session human
reset); the budget stop and soft-limit notice refresh from `GET /api/me`
(policy TTL, 60 s) instead of per-message costs; model-visible notices travel
in the thrown block errors (no `session.prompt` injection). The gateway remains
the exact budget enforcer.

## Install

Copy the file into a config directory OpenCode loads, for example:

- project: `.opencode/plugins/team-ai-allowance.ts`
- managed global: `/etc/opencode/plugins/team-ai-allowance.ts`
- user global: `~/.config/opencode/plugins/team-ai-allowance.ts`

The build is self-contained: it imports only Node built-ins, so there is no
install step beside the file. A managed config can list the same path
so a member cannot quietly remove it.

Environment:

| Variable | Meaning |
| --- | --- |
| `TAA_BASE_URL` (or `TAA_URL`) | Control-service origin, e.g. `http://127.0.0.1:8787` |
| `TAA_MEMBER_KEY` (or `TAA_KEY`) | Member gateway key, used as a bearer token |
| `TAA_MEMBER_KEY_FILE` (or `TAA_KEY_FILE`) | Mode-0600 file holding the key; wins over the direct value |
| `TAA_PLUGIN_STATE_DIR` | State directory; default `$XDG_STATE_HOME/team-ai-allowance/opencode` or `~/.local/state/team-ai-allowance/opencode` |

Missing configuration is not fatal: the local rules still run, and network
actions are skipped.

## What it does

- **Budget.** Accumulates `cost` from completed assistant messages once per
  message id. Warns at each configured ratio (50% and 80% by default). At 100%
  it blocks the next tool by throwing, posts the stop, and calls
  `session.abort`.
- **Unattended.** Counts minutes and tool calls since the last non-synthetic
  human message: 30 minutes or 40 steps in working hours, 10 minutes or 15
  steps off-hours. Working hours come from the policy's IANA zone, weekdays and
  holidays.
- **Loop.** The same tool plus canonical-argument hash 5 times, or the same
  normalised error signature 3 times, pauses the session and aborts it.
- **A human clears it.** A new human message clears an unattended or loop pause
  and resets the counters. A budget stop clears only when the budget is raised.
- **Notices.** `session.prompt` with `noReply: true`, so the text reaches the
  model without a model call and a thrown notice costs nothing.
- **Soft limit.** Checks `GET /api/me` at most once a minute, and once the
  team's soft ratio is passed injects one model-visible note:
  `Allowance: <n>% of today's budget used. If you need more for this task, call
  request_more_budget now, before it runs out.`
- **Events.** Posts `{kind, sessionId, at, detail}` to
  `POST /api/me/session-events` so the manager console can show what happened.
  Kinds: `budget_warning`, `budget_stop`, `unattended_pause`, `loop_pause`,
  `soft_limit_notice`, `policy_fallback`.

## Policy contract

`GET /api/me/session-policy` (bearer member key) returns a JSON object. Every
field is optional and falls back individually:

```json
{
  "budget": {
    "limitUsd": 2.0,
    "spentUsd": 0.0,
    "warnRatios": [0.5, 0.8],
    "stopRatio": 1
  },
  "unattended": {
    "workingHours": {
      "timeZone": "Europe/Berlin",
      "workingDays": [1, 2, 3, 4, 5],
      "startMinute": 420,
      "endMinute": 1140,
      "holidays": ["2026-12-25"]
    },
    "working": { "maxMinutes": 30, "maxSteps": 40 },
    "offHours": { "maxMinutes": 10, "maxSteps": 15 }
  },
  "loop": { "sameToolArgs": 5, "sameError": 3 },
  "softLimit": { "ratio": 0.8 }
}
```

The policy is cached for 60 seconds. If the route is absent or the service is
down, the plugin tries `GET /api/me`; if that also fails it uses the last known
policy from disk. With no policy ever fetched it uses the built-in defaults and
does not enforce a budget it cannot know.

`POST /api/me/session-events` accepts the event body above and may answer any
2xx. Failures are ignored and never block a tool call.

## Privacy

The state file is per session under the state directory. It contains a session
id, timestamps, counters, message ids, costs, hashes of tool arguments and
errors, pause state and the last policy. It never contains prompt text,
assistant text, tool arguments or tool output. Event bodies contain ids,
numbers, ratios and kinds only.

## Build and test

```sh
node src/plugin/build.ts
node --test test/plugin/*.test.ts
```

The build refuses a source that imports a runtime package. The test suite checks
that the committed build matches the source, type-checks under the project's
strict settings, and drives a fake event stream and fake client through budget,
stop, unattended, loop, restart and privacy cases.
