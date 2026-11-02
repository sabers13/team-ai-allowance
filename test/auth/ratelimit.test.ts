import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoginRateLimiter } from "../../src/auth/index.ts";
import type { Clock } from "../../src/contracts.ts";

class ClockStub implements Clock {
  #nowMs = Date.parse("2026-10-31T09:00:00.000Z");

  now(): Date {
    return new Date(this.#nowMs);
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

test("failures from one IP are limited per window", () => {
  const clock = new ClockStub();
  const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 10_000, clock });
  assert.equal(limiter.check("127.0.0.1").limited, false);
  limiter.recordFailure("127.0.0.1");
  assert.equal(limiter.check("127.0.0.1").limited, false);
  limiter.recordFailure("127.0.0.1");
  const limited = limiter.check("127.0.0.1");
  assert.equal(limited.limited, true);
  assert.equal(limited.retryAfterSeconds, 10);

  // Another address is unaffected.
  assert.equal(limiter.check("10.0.0.9").limited, false);

  clock.advance(10_001);
  assert.equal(limiter.check("127.0.0.1").limited, false);
});

test("clearing a successful login resets the counter", () => {
  const clock = new ClockStub();
  const limiter = createLoginRateLimiter({ maxAttempts: 1, windowMs: 10_000, clock });
  limiter.recordFailure("127.0.0.1");
  assert.equal(limiter.check("127.0.0.1").limited, true);
  limiter.clear("127.0.0.1");
  assert.equal(limiter.check("127.0.0.1").limited, false);
});

test("the retry hint is never zero while limited", () => {
  const clock = new ClockStub();
  const limiter = createLoginRateLimiter({ maxAttempts: 1, windowMs: 1, clock });
  limiter.recordFailure("127.0.0.1");
  const state = limiter.check("127.0.0.1");
  assert.equal(state.limited, true);
  assert.equal(state.retryAfterSeconds, 1);
});
