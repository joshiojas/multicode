/**
 * A source of the current time. Injecting a clock keeps the domain deterministic and testable — the
 * production code path uses {@link systemClock}; tests can supply a {@link ManualClock}.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** ISO-8601 timestamp for the current instant. */
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

/** A clock whose time only advances when told to. Useful in tests. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(startMs = 0) {
    this.#ms = startMs;
  }

  now(): number {
    return this.#ms;
  }

  isoNow(): string {
    return new Date(this.#ms).toISOString();
  }

  /** Advance the clock by `deltaMs` and return the new time. */
  advance(deltaMs: number): number {
    this.#ms += deltaMs;
    return this.#ms;
  }

  set(ms: number): void {
    this.#ms = ms;
  }
}
