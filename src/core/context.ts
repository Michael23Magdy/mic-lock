import type { Clock } from "../util/time.js";
import type { Liveness } from "./liveness.js";

/**
 * Everything the engine needs that is injectable for tests: the shared state
 * directory, a clock, and a liveness oracle. Kept tiny on purpose.
 */
export interface EngineContext {
  stateDir: string;
  clock: Clock;
  liveness: Liveness;
}

export function now(ctx: EngineContext): number {
  return ctx.clock.now();
}
