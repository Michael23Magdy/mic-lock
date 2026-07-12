/** Exponential backoff with full jitter, capped. Used when spinning for the gate. */
export function jitteredBackoff(attempt: number, baseMs = 5, capMs = 120): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}
