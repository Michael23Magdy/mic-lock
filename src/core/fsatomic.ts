/**
 * Atomic filesystem primitives. Every persisted mutation in mic-lock goes
 * through here so that concurrent processes never observe a torn or partial
 * record. Verified on APFS: `mkdir`/`link` are create-only (EEXIST on race),
 * `rename` atomically overwrites, `rename` of a missing source is ENOENT.
 *
 * We use synchronous fs deliberately: critical sections run under the gate and
 * are tiny, and sync calls make the atomicity reasoning free of intra-process
 * interleaving.
 */
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Create a directory exclusively. Returns true if created, false if it already existed. */
export function mkdirExcl(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (err) {
    if (isErrno(err, "EEXIST")) return false;
    throw err;
  }
}

/** Hard-link create-only. Returns true if created, false if the destination existed. */
export function linkExcl(target: string, dest: string): boolean {
  try {
    linkSync(target, dest);
    return true;
  } catch (err) {
    if (isErrno(err, "EEXIST")) return false;
    throw err;
  }
}

/**
 * Write JSON to a temp file in the same dir, then atomically rename over `path`.
 * Atomicity comes from `rename` (readers only ever read the final path, never
 * the temp), so we deliberately do NOT fsync: durability across power-loss is
 * irrelevant for ephemeral coordination state, and fsync-per-write cripples
 * throughput under gate contention.
 */
export function writeAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const data = JSON.stringify(value, null, 2);
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Read + parse JSON, returning null on missing file or a mid-write partial read. */
export function readJsonOrNull<T>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** List a directory, treating a missing directory as empty. */
export function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
}

/** Unlink, ignoring a missing file. */
export function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
}

/** Recursively remove a path, ignoring absence. */
export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Rename, reporting whether the source existed. Returns false on ENOENT so
 * callers can treat "someone else already moved it" as a lost race.
 */
export function renameIfExists(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

export function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
