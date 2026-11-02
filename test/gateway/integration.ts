/**
 * Integration check for the gateway client against the real pinned LiteLLM.
 *
 * Run with `make gateway-it`, which brings the compose stack up and passes
 * `TAA_GATEWAY_URL` and `LITELLM_MASTER_KEY` in the environment. The script
 * never prints a secret: it prints the step name, the HTTP status and the
 * gateway's error type only.
 *
 * It proves, against the real gateway:
 * - a team, user, membership and key can be created;
 * - the key can call the enabled mock model, and is refused another model;
 * - the budget limit produces the documented 422 budget refusal;
 * - block, unblock and rotation change what the key can do;
 * - the OpenAI Responses and Anthropic Messages routes reach the mock;
 * - spend logs come back without prompt text;
 * - the client maps a real 404 to `not_found`;
 * - the objects can be deleted again.
 */
import { GatewayError, LiteLLMGatewayClient } from "../../src/gateway/index.ts";

const baseUrl = process.env.TAA_GATEWAY_URL ?? "http://127.0.0.1:14000";
const masterKey = process.env.LITELLM_MASTER_KEY ?? "";

if (masterKey.length === 0) {
  process.stderr.write("integration: LITELLM_MASTER_KEY is not set\n");
  process.exit(2);
}

const client = new LiteLLMGatewayClient({ baseUrl, masterKey, timeoutMs: 30_000 });
const runId = `it-${Date.now().toString(36)}`;
const failures: string[] = [];
let stepNumber = 0;

async function step(name: string, body: () => Promise<string | null>): Promise<void> {
  stepNumber += 1;
  const label = `${String(stepNumber).padStart(2, "0")}. ${name}`;
  try {
    const detail = await body();
    process.stdout.write(`PASS ${label}${detail === null ? "" : ` — ${detail}`}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    process.stdout.write(`FAIL ${label} — ${message}\n`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

async function call(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
}

function errorType(body: Record<string, unknown> | null): string | null {
  const error = body?.error;
  if (typeof error !== "object" || error === null) return null;
  const type = (error as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function usageOf(body: Record<string, unknown> | null): Record<string, unknown> | null {
  const usage = body?.usage;
  return typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : null;
}

async function waitForSpend(from: string, to: string): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await client.listSpend({ from, to });
    if (rows.length > 0) return rows.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 0;
}

const teamName = `it-team-${runId}`;
const userId = `it-user-${runId}`;
const keyAlias = `taa-${runId}`;
const models = ["mock-cheap", "mock-flagship"];

let teamId: string | null = null;
let createdKeyHash: string | null = null;
let secret: string | null = null;

try {
  await step("create a team", async () => {
    teamId = await client.createTeam({ name: teamName, monthlyBudgetUsd: 10, modelIds: models });
    return `team ${teamId}`;
  });

  if (teamId === null) throw new Error("no team id; remaining steps cannot run");
  const activeTeam = teamId;

  await step("create a user and add it to the team", async () => {
    await client.createUser({ userId, userAlias: "Integration member" });
    await client.addTeamMember(activeTeam, userId, "member");
    const team = await client.getTeamInfo(activeTeam);
    return team === null ? "team info empty" : `team alias ${team.teamAlias ?? "(none)"}`;
  });

  await step("create a key restricted to one model", async () => {
    const created = await client.createKey({
      keyAlias,
      teamId: activeTeam,
      userId,
      models: ["mock-cheap"],
      maxBudgetUsd: 1,
      budgetDuration: "1d",
      tpmLimit: 60_000,
      rpmLimit: 60,
    });
    createdKeyHash = created.keyHash;
    secret = created.secret;
    assert(secret.startsWith("sk-"), "the gateway returned no sk- secret");
    assert(/^[0-9a-f]{64}$/.test(created.keyHash), "the client did not hash the secret");
    return `alias ${created.keyAlias}, hash ${created.keyHash.slice(0, 8)}…, budget USD 1/1d`;
  });

  if (secret === null || createdKeyHash === null) throw new Error("no key created");
  let activeSecret = secret as string;

  await step("an allowed model answers through the gateway", async () => {
    const result = await call("/v1/chat/completions", activeSecret, {
      model: "mock-cheap",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
    });
    assert(result.status === 200, `status ${result.status}`);
    const usage = usageOf(result.body);
    assert(usage?.prompt_tokens === 12, "prompt tokens are not the mock's fixed 12");
    assert(usage?.completion_tokens === 7, "completion tokens are not the mock's fixed 7");
    return "HTTP 200, usage 12 in / 7 out";
  });

  await step("a model outside the key's list is refused", async () => {
    const result = await call("/v1/chat/completions", activeSecret, {
      model: "mock-flagship",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(result.status === 403, `expected 403, got ${result.status}`);
    assert(
      errorType(result.body) === "key_model_access_denied",
      `unexpected error type ${String(errorType(result.body))}`,
    );
    return "HTTP 403 key_model_access_denied";
  });

  await step("update the key's models, budget and limits", async () => {
    await client.updateKey(
      { keyAlias, keyHash: createdKeyHash ?? "" },
      {
        keyAlias,
        models,
        maxBudgetUsd: 0.000005,
        budgetDuration: "1d",
        tpmLimit: 120_000,
        rpmLimit: 120,
        blocked: false,
      },
    );
    const updated = await client.getKeyInfo({ keyAlias, keyHash: createdKeyHash ?? "" });
    assert(updated !== null, "key info is empty after update");
    assert(updated.models?.includes("mock-flagship") === true, "models were not updated");
    return `models ${updated.models?.join(", ") ?? "(none)"}`;
  });

  await step("an exhausted budget is refused with the documented 422", async () => {
    const result = await call("/v1/chat/completions", activeSecret, {
      model: "mock-cheap",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(result.status === 422, `expected 422, got ${result.status}`);
    assert(
      errorType(result.body) === "budget_exceeded",
      `unexpected error type ${String(errorType(result.body))}`,
    );
    return "HTTP 422 budget_exceeded";
  });

  await step("raise the budget again and let the key work", async () => {
    await client.updateKey(
      { keyAlias, keyHash: createdKeyHash ?? "" },
      {
        keyAlias,
        models,
        maxBudgetUsd: 5,
        budgetDuration: "1d",
        tpmLimit: 120_000,
        rpmLimit: 120,
        blocked: false,
      },
    );
    const result = await call("/v1/chat/completions", activeSecret, {
      model: "mock-flagship",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(result.status === 200, `status ${result.status}`);
    return "HTTP 200 on the second model";
  });

  await step("block the key, then unblock it", async () => {
    const ref = { keyAlias, keyHash: createdKeyHash ?? "" };
    await client.blockKey(ref);
    const blocked = await call("/v1/chat/completions", activeSecret, {
      model: "mock-cheap",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(
      blocked.status === 401 || blocked.status === 403,
      `a blocked key was not refused (status ${blocked.status})`,
    );
    await client.unblockKey(ref);
    const unblocked = await call("/v1/chat/completions", activeSecret, {
      model: "mock-cheap",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(unblocked.status === 200, `unblocked key still refused (status ${unblocked.status})`);
    return `blocked → HTTP ${blocked.status}, unblocked → HTTP 200`;
  });

  await step("rotate the key: the old secret stops, the new one works", async () => {
    const rotated = await client.regenerateKey({ keyAlias, keyHash: createdKeyHash ?? "" });
    createdKeyHash = rotated.keyHash;
    const oldSecret = activeSecret;
    activeSecret = rotated.secret;
    const oldResult = await call("/v1/chat/completions", oldSecret, {
      model: "mock-cheap",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(
      oldResult.status === 401 || oldResult.status === 403,
      `the old secret still works (status ${oldResult.status})`,
    );
    const newResult = await call("/v1/chat/completions", activeSecret, {
      model: "mock-cheap",
      messages: [{ role: "user", content: "ping" }],
    });
    assert(newResult.status === 200, `the new secret does not work (status ${newResult.status})`);
    return `old → HTTP ${oldResult.status}, new → HTTP 200`;
  });

  await step("the OpenAI Responses route answers", async () => {
    const result = await call("/v1/responses", activeSecret, {
      model: "mock-cheap",
      input: "ping",
      max_output_tokens: 16,
    });
    assert(result.status === 200, `status ${result.status}`);
    const output = result.body?.output;
    assert(Array.isArray(output) && output.length > 0, "no response output");
    return "HTTP 200 with output";
  });

  await step("the Anthropic Messages route answers", async () => {
    const result = await call(
      "/v1/messages",
      activeSecret,
      {
        model: "mock-cheap",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      },
      { "anthropic-version": "2023-06-01" },
    );
    assert(result.status === 200, `status ${result.status}`);
    const content = result.body?.content;
    assert(Array.isArray(content) && content.length > 0, "no message content");
    return "HTTP 200 with content";
  });

  await step("spend logs come back without prompt text", async () => {
    const to = new Date(Date.now() + 60_000).toISOString();
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const count = await waitForSpend(from, to);
    assert(count > 0, "no spend rows appeared within 20s");
    const rows = await client.listSpend(
      createdKeyHash === null ? { from, to } : { from, to, keyHash: createdKeyHash },
    );
    const total = rows.reduce((sum, row) => sum + row.spendUsd, 0);
    const text = JSON.stringify(rows);
    assert(!/messages|prompt_text|completion_text/.test(text), "spend row carries prompt text");
    return `${rows.length} row(s), USD ${total.toFixed(6)}`;
  });

  await step("a real 404 is mapped to not_found", async () => {
    try {
      await client.getKeyInfo({
        keyAlias: "taa-does-not-exist",
        keyHash: "0".repeat(64),
      });
      throw new Error("expected a not_found error");
    } catch (error) {
      assert(error instanceof GatewayError, "the client threw a non-GatewayError");
      assert(error.code === "not_found", `mapped ${error.code}, expected not_found`);
      return "GatewayError code not_found";
    }
  });
} finally {
  await step("delete the key, user and team", async () => {
    if (createdKeyHash !== null) {
      await client.deleteKey({ keyAlias, keyHash: createdKeyHash }).catch(() => undefined);
    }
    if (teamId !== null) {
      await client.removeTeamMember(teamId, userId).catch(() => undefined);
    }
    await client.deleteUser(userId).catch(() => undefined);
    if (teamId !== null) await client.deleteTeam(teamId).catch(() => undefined);
    return "cleaned up";
  });
}

if (failures.length > 0) {
  process.stderr.write(`\nintegration: ${failures.length} step(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nintegration: all ${stepNumber} steps passed\n`);
