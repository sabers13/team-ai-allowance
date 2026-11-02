import type { Clock, IsoDateTime } from "../contracts.ts";

/** The real clock. Every use case takes a `Clock` so tests can freeze time. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A clock a test can move by hand. It starts at the given instant and never
 * follows wall-clock time.
 */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: IsoDateTime | Date) {
    this.current = start instanceof Date ? new Date(start.getTime()) : new Date(start);
    if (Number.isNaN(this.current.getTime())) {
      throw new Error("ManualClock needs a valid start instant");
    }
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(at: IsoDateTime | Date): void {
    this.current = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceHours(hours: number): void {
    this.advanceMs(hours * 60 * 60 * 1000);
  }

  advanceDays(days: number): void {
    this.advanceHours(days * 24);
  }
}
