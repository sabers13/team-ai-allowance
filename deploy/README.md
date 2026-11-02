# The local stack

`deploy/compose.yaml` is a podman compose project named `taa`. Every container
is named `taa-*`, every published port binds `127.0.0.1`, and every port has an
environment override.

| Service       | Container          | Host port (default) | Override            | Purpose                                     |
| ------------- | ------------------ | ------------------- | ------------------- | ------------------------------------------- |
| `litellm`     | `taa-litellm`      | 14000               | `TAA_GATEWAY_PORT`  | LiteLLM proxy, pinned to v1.105.1 by digest |
| `postgres`    | `taa-postgres`     | 15432               | `TAA_POSTGRES_PORT` | key, team and spend storage                 |
| `control`     | `taa-control`      | 18080               | `TAA_CONSOLE_PORT`  | `taa serve` (API + console + reconciler + watcher), built from `control.Dockerfile` |
| `mail`        | `taa-mail`         | 18025               | `TAA_MAIL_UI_PORT`  | mail catcher UI (SMTP 1025 in the network)  |
| `webhook`     | `taa-webhook`      | 18090               | `TAA_WEBHOOK_PORT`  | JSON webhook catcher                        |
| `mock-upstream` | `taa-mock-upstream` | 14001             | `TAA_MOCK_PORT`     | fake model provider (see `src/mock-upstream`) |

## Use

```sh
make stack-up        # create deploy/.env with random secrets, start everything
make stack-logs      # last 200 log lines
make stack-down      # stop and remove volumes
```

`make gateway-it` starts the stack, waits for LiteLLM, runs the integration
check in `test/gateway/integration.ts`, prints the result and tears the stack
down. Set `TAA_KEEP_STACK=1` to keep it running afterwards. It is opt-in and is
not part of `make test`.

`deploy/.env` is generated with mode 0600 and ignored by git; the values are
never printed. Delete it to rotate every local secret.

`make stack-up` builds `taa-control:local` the first time (set
`TAA_STACK_BUILD=1` to force a rebuild after source changes). The control
service seeds the demo organisation (`TAA_STACK_DEMO_SEED=0` turns that off),
stores SQLite on the `taa-control-data` volume and answers `/health`, the JSON
API under `/api` and the console on `/`. The demo manager is
`priya@example.test`; the password is `TAA_DEMO_MANAGER_PASSWORD` in
`deploy/.env`.

`make demo` is the in-process counterpart: it starts the gateway mock and
`taa serve` with the same demo seed, writes one-time keys and the manager
password to `var/demo-credentials.txt` (mode 0600) and needs no containers.

## Routes

`deploy/litellm.config.yaml` routes `mock-cheap` and `mock-flagship` to
`http://mock-upstream:4001/v1`. The mock answers OpenAI Chat Completions,
OpenAI Responses and Anthropic Messages, streaming and non-streaming, with
fixed usage of 12 prompt / 7 completion tokens. `store_prompts_in_spend_logs`
is explicitly `false`.

The image is pinned by digest in `deploy/compose.yaml`. The tag moves; the digest
does not.
