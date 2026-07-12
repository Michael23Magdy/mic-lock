/**
 * Layer 1: the per-resource coordination gate.
 *
 * A gate is a mutex held for microseconds that serializes every mutation of a
 * resource's state. It is the ONLY place we rely on a lock-free create-only
 * primitive (`mkdir`, atomic on APFS). Because every transition runs inside it,
 * ticket issuance, queue evaluation, granting, and stale-breaking are all
 * trivially race-free — and therefore testable.
 *
 * A held gate older than `gateStaleMs` means a real crash (healthy hold time is
 * sub-millisecond), so it is safe to break: doing so only risks repeating a
 * coordination step, never a device double-use (that is the lease layer's job).
 */
import { uuid } from "../util/ids.js";
import { jitteredBackoff } from "../util/backoff.js";
import { sleep } from "../util/time.js";
import { GateTimeoutError } from "../util/errors.js";
import {
  ensureDir,
  mkdirExcl,
  readJsonOrNull,
  renameIfExists,
  rmrf,
  writeAtomic,
} from "./fsatomic.js";
import type { EngineContext } from "./context.js";
import type { ResourcePaths } from "./paths.js";
import type { Tunables } from "../types.js";

interface GateInfo {
  uuid: string;
  pid: number;
  bootId: string;
  startedAt?: string;
  ts: number;
}

export interface GateHandle {
  uuid: string;
}

function isStaleGate(ctx: EngineContext, info: GateInfo, tun: Tunables): boolean {
  if (info.bootId !== ctx.liveness.bootId()) return true;
  if (!ctx.liveness.pidAlive(info.pid, info.startedAt, info.bootId)) return true;
  if (ctx.clock.now() - info.ts > tun.gateStaleMs) return true;
  return false;
}

/** Acquire the gate, spinning with jittered backoff and breaking a crashed gate. */
export async function takeGate(
  ctx: EngineContext,
  paths: ResourcePaths,
  tun: Tunables,
): Promise<GateHandle> {
  ensureDir(paths.root);
  const deadline = ctx.clock.now() + tun.gateAcquireTimeoutMs;
  let attempt = 0;
  for (;;) {
    if (mkdirExcl(paths.gateDir)) {
      const handle: GateHandle = { uuid: uuid() };
      const info: GateInfo = {
        uuid: handle.uuid,
        pid: process.pid,
        bootId: ctx.liveness.bootId(),
        ts: ctx.clock.now(),
      };
      const startedAt = ctx.liveness.processStartedAt(process.pid);
      if (startedAt !== undefined) info.startedAt = startedAt;
      writeAtomic(paths.gateInfo, info);
      return handle;
    }
    // Gate is held; decide whether it is a live holder or a crash to break.
    const info = readJsonOrNull<GateInfo>(paths.gateInfo);
    if (info && isStaleGate(ctx, info, tun)) {
      const aside = `${paths.gateDir}.dead.${uuid()}`;
      if (renameIfExists(paths.gateDir, aside)) rmrf(aside);
      // else: lost the race to break it; just retry.
      continue;
    }
    if (ctx.clock.now() > deadline) {
      throw new GateTimeoutError(
        `gate for "${paths.enc}" busy for >${tun.gateAcquireTimeoutMs}ms`,
      );
    }
    await sleep(jitteredBackoff(attempt++));
  }
}

/** Release the gate iff we still own it. */
export function releaseGate(paths: ResourcePaths, handle: GateHandle): void {
  const info = readJsonOrNull<GateInfo>(paths.gateInfo);
  if (info && info.uuid === handle.uuid) {
    rmrf(paths.gateDir);
  }
  // Otherwise our gate was broken mid-section; leave whatever is there.
}

/**
 * Run a synchronous critical section under the gate. `fn` MUST NOT await —
 * keeping it synchronous is what guarantees atomicity against other tasks in
 * this process (other processes are excluded by the gate itself).
 */
export async function withGate<T>(
  ctx: EngineContext,
  paths: ResourcePaths,
  tun: Tunables,
  fn: () => T,
): Promise<T> {
  const handle = await takeGate(ctx, paths, tun);
  try {
    return fn();
  } finally {
    releaseGate(paths, handle);
  }
}
