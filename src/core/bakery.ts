/**
 * Layer of fairness: Lamport's Bakery algorithm.
 *
 * Each waiter draws a monotonically increasing ticket and parks a queue entry.
 * Service order is ascending ticket among *live* waiters — dead waiters ahead
 * of you are skipped, so a crashed agent never causes starvation. All reads
 * here are done under the gate, which supplies the atomic snapshot the bakery
 * assumes.
 */
import { join } from "node:path";
import { readdirSafe, readJsonOrNull, unlinkQuiet, writeAtomic } from "./fsatomic.js";
import { isLiveWaiter } from "./staleness.js";
import { parseTicketFromQueueFile } from "../util/ids.js";
import type { EngineContext } from "./context.js";
import type { ResourcePaths } from "./paths.js";
import type { QueueEntry, Tunables } from "../types.js";

export function enqueue(paths: ResourcePaths, entry: QueueEntry): void {
  writeAtomic(paths.queueFile(entry.ticket, entry.ownerUuid), entry);
}

export function removeQueueEntry(paths: ResourcePaths, ticket: number, ownerUuid: string): void {
  unlinkQuiet(paths.queueFile(ticket, ownerUuid));
}

/** All waiters, ascending by ticket (includes dead ones). */
export function listQueue(paths: ResourcePaths): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const f of readdirSafe(paths.queueDir)) {
    if (!f.endsWith(".json")) continue;
    if (parseTicketFromQueueFile(f) === null) continue;
    const e = readJsonOrNull<QueueEntry>(join(paths.queueDir, f));
    if (e) out.push(e);
  }
  out.sort((a, b) => a.ticket - b.ticket);
  return out;
}

/** Live waiters only, ascending by ticket. */
export function liveSortedQueue(
  ctx: EngineContext,
  paths: ResourcePaths,
  tun: Tunables,
): QueueEntry[] {
  return listQueue(paths).filter((e) => isLiveWaiter(ctx, e, tun));
}

/** Rank of an owner among live waiters (0 == head), or -1 if not queued/live. */
export function liveRankOf(live: QueueEntry[], ownerUuid: string): number {
  return live.findIndex((e) => e.ownerUuid === ownerUuid);
}

/** Prune queue entries whose owning process is gone. Caller holds the gate. */
export function pruneDeadWaiters(
  ctx: EngineContext,
  paths: ResourcePaths,
  tun: Tunables,
): QueueEntry[] {
  const pruned: QueueEntry[] = [];
  for (const e of listQueue(paths)) {
    if (!isLiveWaiter(ctx, e, tun)) {
      removeQueueEntry(paths, e.ticket, e.ownerUuid);
      pruned.push(e);
    }
  }
  return pruned;
}
