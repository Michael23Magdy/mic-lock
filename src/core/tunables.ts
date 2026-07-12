import type { Tunables } from "../types.js";

/**
 * Defaults chosen so a healthy holder refreshes ~6 times per lease: it must
 * miss several consecutive heartbeats before another agent reclaims the lock,
 * which tolerates GC pauses and slow test steps without false steals.
 */
export const DEFAULT_TUNABLES: Tunables = {
  ttlMs: 12_000,
  heartbeatMs: 2_000,
  graceMs: 5_000,
  gateStaleMs: 3_000,
  gateAcquireTimeoutMs: 15_000,
};

export function mergeTunables(...partials: Array<Partial<Tunables> | undefined>): Tunables {
  const out: Tunables = { ...DEFAULT_TUNABLES };
  for (const p of partials) {
    if (!p) continue;
    for (const k of Object.keys(p) as Array<keyof Tunables>) {
      const v = p[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}
