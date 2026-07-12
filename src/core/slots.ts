/**
 * Slot model. Capacity is bounded *by construction*: the slot set is fixed, and
 * a lock can only be granted into a free slot. Safety (≤ capacity holders)
 * therefore does not depend on the bakery being correct.
 *
 *   - mutex     -> one slot "0"
 *   - semaphore -> N anonymous slots "0".."N-1"
 *   - pool      -> one slot per concrete device id
 */
import type { ResourceMeta } from "../types.js";

export function slotIds(meta: ResourceMeta): string[] {
  if (meta.kind === "pool") {
    return meta.deviceIds && meta.deviceIds.length > 0 ? [...meta.deviceIds] : ["0"];
  }
  const cap = Math.max(1, meta.capacity);
  return Array.from({ length: cap }, (_, i) => String(i));
}

export function capacityOf(meta: ResourceMeta): number {
  return slotIds(meta).length;
}

/** First slot (in declared order) not currently occupied, or null if full. */
export function pickFreeSlot(meta: ResourceMeta, occupied: ReadonlySet<string>): string | null {
  for (const id of slotIds(meta)) {
    if (!occupied.has(id)) return id;
  }
  return null;
}
