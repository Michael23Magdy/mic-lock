/** Read/write/retire lease records. All mutations run under the gate. */
import { ensureDir, readJsonOrNull, renameIfExists, unlinkQuiet, writeAtomic, readdirSafe } from "./fsatomic.js";
import { join } from "node:path";
import { uuid } from "../util/ids.js";
import type { ResourcePaths } from "./paths.js";
import type { Holder } from "../types.js";

export function readHolder(paths: ResourcePaths, slotId: string): Holder | null {
  return readJsonOrNull<Holder>(paths.holderFile(slotId));
}

/** Every occupied slot's holder record. */
export function listHolders(paths: ResourcePaths): Holder[] {
  const out: Holder[] = [];
  for (const f of readdirSafe(paths.holdersDir)) {
    if (!f.endsWith(".json")) continue;
    const h = readJsonOrNull<Holder>(join(paths.holdersDir, f));
    if (h) out.push(h);
  }
  return out;
}

export function writeHolder(paths: ResourcePaths, holder: Holder): void {
  writeAtomic(paths.holderFile(holder.slotId), holder);
}

export function removeHolder(paths: ResourcePaths, slotId: string): void {
  unlinkQuiet(paths.holderFile(slotId));
}

/** Retire a holder to the dead/ tombstone dir (audit + fence history). */
export function retireHolder(paths: ResourcePaths, holder: Holder): void {
  ensureDir(paths.deadDir);
  const dest = join(paths.deadDir, `${holder.fenceToken}-${uuid()}.json`);
  if (!renameIfExists(paths.holderFile(holder.slotId), dest)) {
    // Already gone; nothing to retire.
    return;
  }
}
