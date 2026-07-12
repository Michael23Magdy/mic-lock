/**
 * Monotonic counters for FIFO tickets and fence tokens. Because every call runs
 * under the gate, a plain read-increment-write is race-free — no CAS needed.
 */
import { readJsonOrNull, writeAtomic } from "./fsatomic.js";
import type { ResourcePaths } from "./paths.js";
import type { Seq } from "../types.js";

function readSeq(paths: ResourcePaths): Seq {
  return readJsonOrNull<Seq>(paths.seq) ?? { nextTicket: 1, nextFence: 1 };
}

/** Draw the next FIFO ticket. Caller must hold the gate. */
export function drawTicket(paths: ResourcePaths): number {
  const s = readSeq(paths);
  const t = s.nextTicket;
  s.nextTicket = t + 1;
  writeAtomic(paths.seq, s);
  return t;
}

/**
 * Draw the next fence token. Fence tokens are strictly monotonic and never
 * reset for the life of the resource. Caller must hold the gate.
 */
export function drawFence(paths: ResourcePaths): number {
  const s = readSeq(paths);
  const f = s.nextFence;
  s.nextFence = f + 1;
  writeAtomic(paths.seq, s);
  return f;
}
