/**
 * Append-only event log (events.ndjson). Appends happen only under the gate so
 * lines never interleave. The reader tolerates a trailing partial line.
 */
import { appendFileSync } from "node:fs";
import { ensureDir, readdirSafe } from "./fsatomic.js";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { isErrno } from "./fsatomic.js";
import type { EventRecord } from "../types.js";
import type { ResourcePaths } from "./paths.js";

/** Append one event line. Caller must hold the gate for `paths`. */
export function appendEvent(paths: ResourcePaths, record: EventRecord): void {
  ensureDir(dirname(paths.events));
  appendFileSync(paths.events, JSON.stringify(record) + "\n");
}

/** Read all complete event lines from a resource's log. */
export function readEvents(paths: ResourcePaths): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(paths.events, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  const out: EventRecord[] = [];
  const lines = raw.split("\n");
  // The last element after split is "" on a well-terminated file, or a partial
  // line mid-write; either way skipping incomplete parses is safe.
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as EventRecord);
    } catch {
      /* partial trailing line — ignore */
    }
  }
  return out;
}

/** True if a resource directory has ever recorded events (used by discovery). */
export function hasEvents(paths: ResourcePaths): boolean {
  return readdirSafe(paths.root).includes("events.ndjson");
}
