import { homedir } from "node:os";
import { join } from "node:path";
import { encodeResourceName, padTicket } from "../util/ids.js";

/** Current on-disk schema version. Bumped only on breaking layout changes. */
export const SCHEMA_VERSION = 1;

/** Resolve the shared state directory (must be outside any single worktree). */
export function defaultStateDir(): string {
  return process.env.MIC_LOCK_STATE_DIR ?? join(homedir(), ".mic-lock");
}

export interface StatePaths {
  root: string;
  versionFile: string;
  configFile: string;
  bootFile: string;
  resourcesDir: string;
}

export function statePaths(stateDir: string): StatePaths {
  return {
    root: stateDir,
    versionFile: join(stateDir, "version"),
    configFile: join(stateDir, "config.json"),
    bootFile: join(stateDir, "boot"),
    resourcesDir: join(stateDir, "resources"),
  };
}

export interface ResourcePaths {
  /** The encoded directory name (stable, filesystem-safe). */
  enc: string;
  root: string;
  meta: string;
  gateDir: string;
  gateInfo: string;
  seq: string;
  holdersDir: string;
  queueDir: string;
  deadDir: string;
  events: string;
  holderFile: (slotId: string) => string;
  queueFile: (ticket: number, ownerUuid: string) => string;
}

export function resourcePaths(stateDir: string, name: string): ResourcePaths {
  const enc = encodeResourceName(name);
  const root = join(stateDir, "resources", enc);
  return {
    enc,
    root,
    meta: join(root, "meta.json"),
    gateDir: join(root, "gate.lock"),
    gateInfo: join(root, "gate.lock", "info.json"),
    seq: join(root, "seq.json"),
    holdersDir: join(root, "holders"),
    queueDir: join(root, "queue"),
    deadDir: join(root, "dead"),
    events: join(root, "events.ndjson"),
    holderFile: (slotId: string) => join(root, "holders", `${encodeSlot(slotId)}.json`),
    queueFile: (ticket: number, ownerUuid: string) =>
      join(root, "queue", `${padTicket(ticket)}-${ownerUuid}.json`),
  };
}

/** Slot ids may be device serials/UDIDs with unsafe characters; encode them too. */
export function encodeSlot(slotId: string): string {
  return slotId.replace(/[^A-Za-z0-9._-]/g, "_");
}
