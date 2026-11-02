import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "../../src/core/clock.ts";
import type { IntervalScheduler } from "../../src/core/index.ts";
import { loadWatcherConfig, Watcher } from "../../src/watcher/index.ts";
import { makeWatchFixture } from "./harness.ts";

test("the watcher config defaults to 30 s, a 60 s overlap and the local console", () => {
  assert.deepEqual(loadWatcherConfig({}), {
    intervalMs: 30_000,
    overlapMs: 60_000,
    publicUrl: "http://localhost:18080",
  });
});

test("the watcher config reads the interval and trims a public URL", () => {
  assert.equal(loadWatcherConfig({ TAA_WATCH_INTERVAL_MS: "5000" }).intervalMs, 5000);
  assert.equal(
    loadWatcherConfig({ TAA_WATCH_INTERVAL_MS: "10" }).intervalMs,
    30_000,
    "too small falls back",
  );
  assert.equal(loadWatcherConfig({ TAA_WATCH_INTERVAL_MS: "soon" }).intervalMs, 30_000);
  assert.equal(
    loadWatcherConfig({ TAA_PUBLIC_URL: "https://console.example.com/" }).publicUrl,
    "https://console.example.com",
  );
});

test("the watcher loop uses the injected scheduler and runs one tick at a time", async () => {
  const fx = await makeWatchFixture({ start: "2026-10-05T08:00:00.000Z" });
  try {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const scheduler: IntervalScheduler = {
      setInterval: (fn, ms) => {
        scheduled.push({ fn, ms });
        return "handle-1";
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    };
    const watcher = new Watcher({
      store: fx.store,
      gateway: fx.gateway,
      clock: new ManualClock("2026-10-05T08:00:00.000Z"),
      notifier: fx.notifier,
      config: { intervalMs: 30_000, overlapMs: 60_000, publicUrl: "https://console.test" },
      scheduler,
    });
    assert.equal(watcher.isRunning(), false);
    watcher.start();
    watcher.start();
    assert.equal(watcher.isRunning(), true);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.ms, 30_000);
    watcher.stop();
    watcher.stop();
    assert.equal(watcher.isRunning(), false);
    assert.deepEqual(cleared, ["handle-1"]);
  } finally {
    fx.close();
  }
});
