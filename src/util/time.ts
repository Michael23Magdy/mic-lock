/** An injectable clock so tests can advance time deterministically. */
export interface Clock {
  now(): number;
}

export const realClock: Clock = {
  now: () => Date.now(),
};

/** A controllable clock for tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compact human duration, e.g. 1500 -> "1.5s", 65000 -> "1m5s". */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
