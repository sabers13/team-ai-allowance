/**
 * Non-streaming test meter for the dogfood budgets.
 *
 * Why this exists: the pinned LiteLLM build logs *streamed* chat completions
 * at USD 0 when the upstream puts `usage.cost` in the final chunk (open
 * LiteLLM issue #48937). OpenCode always streams, so an agent's own calls do
 * not move its cost budget even though the gateway records the tokens. The
 * gateway's per-key budget still enforces exactly; it just needs spend to
 * accrue. This helper makes ordinary non-streaming calls on one member's key
 * — which the pinned build does price — so the tiny test budgets
 * really run out.
 *
 * Each call carries a unique prefix, so the upstream prompt cache cannot
 * discount it, and about `--pad-tokens` input tokens, which makes one call
 * cost about what one OpenCode step costs at the test prices.
 *
 * No prompt or response text is stored or printed: only status codes, token
 * counts and spend. The key is read from `keys/<member>.key` and never shown.
 *
 * Usage:
 *   node scripts/dogfood/meter.ts --member m1 --calls 4
 *   node scripts/dogfood/meter.ts --member m1 --calls 1 --pad-tokens 200
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DOGFOOD_DIR, GATEWAY_URL, keyPath, MODEL } from "./config.ts";
import { readEnvFile } from "./env.ts";

const SENTENCE = "The allowance gateway meters every model call for budget enforcement. ";

function argOf(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function spendOf(secret: string, masterKey: string): Promise<number> {
  const response = await fetch(
    `${GATEWAY_URL}/key/info?key=${createHash("sha256").update(secret).digest("hex")}`,
    { headers: { authorization: `Bearer ${masterKey}` } },
  );
  if (!response.ok) return -1;
  const body = (await response.json()) as { info?: { spend?: unknown } };
  const spend = Number(body.info?.spend ?? 0);
  return Number.isFinite(spend) ? Math.round(spend * 1_000_000) / 1_000_000 : -1;
}

async function main(): Promise<number> {
  const member = argOf("member", "");
  const calls = Number.parseInt(argOf("calls", "1"), 10);
  const padTokens = Number.parseInt(argOf("pad-tokens", "4000"), 10);
  if (member === "" || !Number.isFinite(calls) || calls < 1) {
    process.stderr.write("usage: node scripts/dogfood/meter.ts --member <m1..p3> --calls <n>\n");
    return 2;
  }
  const secret = readFileSync(keyPath(member), "utf8").trim();
  const state = readEnvFile(join(DOGFOOD_DIR, "state", "stack.env"));
  const masterKey = state.LITELLM_MASTER_KEY ?? "";
  const padding = SENTENCE.repeat(Math.max(1, Math.round((padTokens * 4) / SENTENCE.length)));

  const before = await spendOf(secret, masterKey);
  let ok = 0;
  let tokens = 0;
  for (let i = 0; i < calls; i++) {
    // A random nonce first: the upstream caches on the prompt prefix.
    const nonce = randomBytes(8).toString("hex");
    const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `${nonce} ${padding}Reply with OK.` }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    let detail = "";
    try {
      const body = (await response.json()) as {
        usage?: { total_tokens?: number };
        error?: { message?: string };
      };
      tokens += body.usage?.total_tokens ?? 0;
      detail = body.error?.message?.slice(0, 160) ?? "";
    } catch {
      detail = "no JSON body";
    }
    process.stdout.write(`${member} call ${i + 1}/${calls}: HTTP ${response.status} ${detail}\n`);
    if (response.status === 200) ok += 1;
    else break;
  }
  // LiteLLM writes the spend row asynchronously; give it a moment to settle.
  let after = before;
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    after = await spendOf(secret, masterKey);
    if (after > before) break;
  }
  const delta =
    before >= 0 && after >= 0 ? Math.round((after - before) * 1_000_000) / 1_000_000 : -1;
  process.stdout.write(
    `${member}: ${ok}/${calls} answered, ${tokens} tokens, spend USD ${before.toFixed(6)} -> ` +
      `${after.toFixed(6)} (delta ${delta.toFixed(6)})\n`,
  );
  return ok === calls ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`meter: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
