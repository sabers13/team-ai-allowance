/**
 * Per-IP login rate limiting.
 *
 * A fixed window: after `maxAttempts` failed logins from one address inside
 * `windowMs`, further attempts get 429 until the window resets. Only failures
 * count, so a busy but successful console is never throttled.
 */

import type { Clock } from "../contracts.ts";

export interface RateLimitState {
  limited: boolean;
  /** Seconds until the window resets; 0 when not limited. */
  retryAfterSeconds: number;
}

export interface LoginRateLimiter {
  check(ip: string): RateLimitState;
  recordFailure(ip: string): void;
  clear(ip: string): void;
}

export interface LoginRateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
  clock: Clock;
}

interface WindowState {
  failures: number;
  resetAtMs: number;
}

export function createLoginRateLimiter(options: LoginRateLimiterOptions): LoginRateLimiter {
  const windows = new Map<string, WindowState>();
  const { maxAttempts, windowMs, clock } = options;

  const current = (ip: string, nowMs: number): WindowState => {
    const existing = windows.get(ip);
    if (existing !== undefined && existing.resetAtMs > nowMs) return existing;
    const fresh: WindowState = { failures: 0, resetAtMs: nowMs + windowMs };
    windows.set(ip, fresh);
    return fresh;
  };

  const prune = (nowMs: number): void => {
    if (windows.size < 10_000) return;
    for (const [ip, state] of windows) {
      if (state.resetAtMs <= nowMs) windows.delete(ip);
    }
  };

  return {
    check(ip) {
      const nowMs = clock.now().getTime();
      const state = current(ip, nowMs);
      if (state.failures < maxAttempts) return { limited: false, retryAfterSeconds: 0 };
      const seconds = Math.max(1, Math.ceil((state.resetAtMs - nowMs) / 1000));
      return { limited: true, retryAfterSeconds: seconds };
    },
    recordFailure(ip) {
      const nowMs = clock.now().getTime();
      prune(nowMs);
      const state = current(ip, nowMs);
      state.failures += 1;
      windows.set(ip, state);
    },
    clear(ip) {
      windows.delete(ip);
    },
  };
}
