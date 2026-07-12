/**
 * The lock engine: acquire / release / approve / renew / status.
 *
 * Orchestrates the two layers. Every state transition runs inside `withGate`
 * (Layer 1), so grants, stale-breaks and ticket draws are serialized and
 * race-free. The holder record it writes carries the lease + fence (Layer 2).
 *
 * The engine is a pure library: it never calls process.exit or prints. The CLI
 * and the keeper drive it; tests drive it with a fake clock + fake liveness and
 * an injected `waitForWake`.
 */
import { join } from "node:path";
import { resourcePaths, statePaths } from "./paths.js";
import { withGate } from "./gate.js";
import { drawFence, drawTicket } from "./seq.js";
import { appendEvent } from "./eventlog.js";
import {
  enqueue,
  liveRankOf,
  liveSortedQueue,
  listQueue,
  pruneDeadWaiters,
  removeQueueEntry,
} from "./bakery.js";
import { listHolders, readHolder, retireHolder, writeHolder } from "./holder.js";
import { isLiveWaiter, isStaleHolder } from "./staleness.js";
import { capacityOf, pickFreeSlot, slotIds } from "./slots.js";
import { buildIdentity } from "./identity.js";
import { readdirSafe, readJsonOrNull, unlinkQuiet, writeAtomic } from "./fsatomic.js";
import { statSync } from "node:fs";
import { buildMeta, readMeta, resolveTunables, writeMeta } from "../config/config.js";
import { BusyError, HeldForApprovalError, MicLockError, SupersededError, TimeoutError } from "../util/errors.js";
import { ExitCode } from "../util/exitcodes.js";
import { realClock, sleep } from "../util/time.js";
import { realLiveness } from "./liveness.js";
import type { EngineContext } from "./context.js";
import type { ResourcePaths } from "./paths.js";
import type {
  AcquireResult,
  Holder,
  Identity,
  LockMode,
  QueueEntry,
  ResourceKind,
  ResourceMeta,
  Tunables,
} from "../types.js";
import type { Clock } from "../util/time.js";
import type { Liveness } from "./liveness.js";

export type Waker = (maxMs: number) => Promise<void>;

export interface AcquireOptions {
  mode?: LockMode;
  wait?: boolean;
  timeoutMs?: number;
  ttlMs?: number;
  label?: string;
  agentPid?: number;
  cwd?: string;
  cmd?: string;
  /** Resource shape used only when the resource is first created. */
  kind?: ResourceKind;
  capacity?: number;
  deviceIds?: string[];
  /** Reuse a pre-built identity (the keeper reuses the original ownerUuid). */
  identity?: Identity;
  /** Low-latency wake source; defaults to a short poll. */
  waitForWake?: Waker;
  /** Called once when we begin waiting (not granted immediately). */
  onQueued?: (info: QueueInfo) => void;
}

export interface QueueInfo {
  resource: string;
  ticket: number;
  ownerUuid: string;
  /** 0-based position among live waiters. */
  position: number;
  waitersAhead: number;
  blockedByApproval: boolean;
}

export interface Waiter {
  resource: string;
  paths: ResourcePaths;
  identity: Identity;
  ticket: number;
  mode: LockMode;
  ttlMs: number | undefined;
  startedAt: number;
  granted: boolean;
  blockedByApproval: boolean;
}

export interface ReleaseOptions {
  ownerUuid?: string;
  token?: number;
  slotId?: string;
  label?: string;
  force?: boolean;
  reason?: string;
  by?: string;
}

export interface ReleaseResult {
  released: Array<{ slotId: string; ownerUuid: string; fenceToken: number; forced: boolean }>;
}

export interface RenewResult {
  ok: boolean;
  superseded: boolean;
  holder?: Holder;
}

export interface HolderStatus extends Holder {
  live: boolean;
  stale: boolean;
  ageMs: number;
}

export interface WaiterStatus extends QueueEntry {
  live: boolean;
  waitedMs: number;
}

export interface ResourceStatus {
  name: string;
  enc: string;
  kind: ResourceKind;
  capacity: number;
  free: number;
  holders: HolderStatus[];
  queue: WaiterStatus[];
  approvalPending: boolean;
}

export interface LockEngineOptions {
  stateDir: string;
  clock?: Clock;
  liveness?: Liveness;
}

const defaultWaker: Waker = (maxMs) => sleep(Math.min(Math.max(maxMs, 0), 250));

export class LockEngine {
  readonly ctx: EngineContext;

  constructor(opts: LockEngineOptions) {
    this.ctx = {
      stateDir: opts.stateDir,
      clock: opts.clock ?? realClock,
      liveness: opts.liveness ?? realLiveness,
    };
  }

  private tun(paths: ResourcePaths): Tunables {
    return resolveTunables(this.ctx.stateDir, readMeta(paths));
  }

  // ---- Acquire: enter -> poll* -> (grant | leave) --------------------------

  /** Draw a ticket and park in the FIFO queue. Creates the resource if new. */
  async enter(resource: string, opts: AcquireOptions = {}): Promise<Waiter> {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    const mode: LockMode = opts.mode ?? "auto";
    const identity =
      opts.identity ??
      buildIdentity(this.ctx.liveness, {
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        ...(opts.agentPid !== undefined ? { agentPid: opts.agentPid } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
      });
    const startedAt = this.ctx.clock.now();

    let ticket = 0;
    await withGate(this.ctx, paths, this.tun(paths), () => {
      // Ensure the resource exists (default: 1-slot mutex).
      let meta = readMeta(paths);
      if (!meta) {
        meta = buildMeta(this.ctx, resource, {
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
          ...(opts.deviceIds !== undefined ? { deviceIds: opts.deviceIds } : {}),
        });
        writeMeta(paths, meta);
      }
      ticket = drawTicket(paths);
      const now = this.ctx.clock.now();
      const entry: QueueEntry = {
        ticket,
        ownerUuid: identity.ownerUuid,
        pid: identity.pid,
        agentPid: identity.agentPid,
        bootId: identity.bootId,
        mode,
        enqueuedAt: now,
        heartbeatAt: now,
      };
      if (identity.label !== undefined) entry.label = identity.label;
      if (identity.worktree !== undefined) entry.worktree = identity.worktree;
      if (identity.branch !== undefined) entry.branch = identity.branch;
      if (identity.startedAt !== undefined) entry.startedAt = identity.startedAt;
      enqueue(paths, entry);
      appendEvent(paths, {
        ts: now,
        type: "queued",
        resource,
        owner: identity.ownerUuid,
        ticket,
        detail: mode,
      });
    });

    return {
      resource,
      paths,
      identity,
      ticket,
      mode,
      ttlMs: opts.ttlMs,
      startedAt,
      granted: false,
      blockedByApproval: false,
    };
  }

  /** One evaluation. Returns a grant, or null if we must keep waiting. */
  async poll(waiter: Waiter): Promise<AcquireResult | null> {
    const { paths, identity } = waiter;
    let result: AcquireResult | null = null;
    waiter.blockedByApproval = false;

    // Gate-free fast path: only an apparent head-of-line waiter with a free
    // slot needs the gate. Without this, N waiters all serialize through the
    // gate on every poll — the dominant cost under heavy contention. The grant
    // below re-checks everything under the gate, so this is only a filter.
    {
      const meta = readMeta(paths);
      if (!meta) return null;
      const tun = resolveTunables(this.ctx.stateDir, meta);
      const holders = listHolders(paths);
      const liveHolders = holders.filter((h) => !isStaleHolder(this.ctx, h, tun));
      const live = liveSortedQueue(this.ctx, paths, tun);
      const myRank = liveRankOf(live, identity.ownerUuid);
      const cap = capacityOf(meta);
      if (myRank >= 0 && !(myRank < cap && liveHolders.length < cap)) {
        waiter.blockedByApproval = holders.some((h) => h.mode === "until-approved");
        return null;
      }
    }

    await withGate(this.ctx, paths, this.tun(paths), () => {
      const meta = readMeta(paths);
      if (!meta) throw new MicLockError(`resource "${waiter.resource}" vanished`, ExitCode.ERROR);
      const tun = resolveTunables(this.ctx.stateDir, meta);
      const now = this.ctx.clock.now();

      // 1. Reclaim stale holders (crash recovery) under this same gate.
      for (const h of listHolders(paths)) {
        if (isStaleHolder(this.ctx, h, tun)) {
          retireHolder(paths, h);
          appendEvent(paths, {
            ts: now,
            type: "stale-broken",
            resource: waiter.resource,
            owner: h.ownerUuid,
            slot: h.slotId,
            fence: h.fenceToken,
          });
        }
      }

      // 2. Drop crashed waiters so ranking reflects only live contenders.
      pruneDeadWaiters(this.ctx, paths, tun);

      // 3. Where am I in line?
      const live = liveSortedQueue(this.ctx, paths, tun);
      let myRank = liveRankOf(live, identity.ownerUuid);
      if (myRank < 0) {
        // Our entry disappeared while we are demonstrably alive; re-park it in
        // place (same ticket preserves FIFO fairness).
        this.reparkEntry(waiter);
        myRank = 0; // conservative; next poll recomputes precisely.
        return;
      }

      const holders = listHolders(paths);
      const occupied = new Set(holders.map((h) => h.slotId));
      const cap = capacityOf(meta);

      // 4. Grant iff within capacity AND a slot is free (checked under gate).
      if (myRank < cap && occupied.size < cap) {
        const slot = pickFreeSlot(meta, occupied);
        if (slot !== null) {
          result = this.grantUnderGate(waiter, meta, slot, tun);
          return;
        }
      }

      // Not granted: is the blocker a human-approval hold?
      waiter.blockedByApproval = holders.some((h) => h.mode === "until-approved");
    });

    if (result) waiter.granted = true;
    return result;
  }

  private grantUnderGate(
    waiter: Waiter,
    meta: ResourceMeta,
    slot: string,
    tun: Tunables,
    reason?: string,
  ): AcquireResult {
    const { paths, identity, mode } = waiter;
    const now = this.ctx.clock.now();
    const fence = drawFence(paths);
    const deviceId = computeDeviceId(meta, slot);
    const holder: Holder = {
      ownerUuid: identity.ownerUuid,
      slotId: slot,
      pid: identity.pid,
      agentPid: identity.agentPid,
      bootId: identity.bootId,
      fenceToken: fence,
      mode,
      state: mode === "until-approved" ? "held-approval-pending" : "held",
      acquiredAt: now,
      heartbeatAt: now,
      // until-approved and un-ttl'd manual acquires are non-expiring (sticky);
      // `with` and `acquire --ttl` pass an explicit ttl and are lease-reclaimed.
      leaseExpiresAt:
        mode === "until-approved" || waiter.ttlMs === undefined ? null : now + waiter.ttlMs,
    };
    if (deviceId !== undefined) holder.deviceId = deviceId;
    if (identity.label !== undefined) holder.label = identity.label;
    if (identity.worktree !== undefined) holder.worktree = identity.worktree;
    if (identity.branch !== undefined) holder.branch = identity.branch;
    if (identity.startedAt !== undefined) holder.startedAt = identity.startedAt;
    if (identity.cmd !== undefined) holder.cmd = identity.cmd;
    if (reason !== undefined) holder.reason = reason;

    writeHolder(paths, holder);
    removeQueueEntry(paths, waiter.ticket, identity.ownerUuid);
    appendEvent(paths, {
      ts: now,
      type: "granted",
      resource: waiter.resource,
      owner: identity.ownerUuid,
      slot,
      fence,
      ticket: waiter.ticket,
    });
    if (mode === "until-approved") {
      appendEvent(paths, {
        ts: now,
        type: "approval-requested",
        resource: waiter.resource,
        owner: identity.ownerUuid,
        slot,
        fence,
      });
    }
    const res: AcquireResult = {
      resource: waiter.resource,
      slotId: slot,
      fenceToken: fence,
      ownerUuid: identity.ownerUuid,
      mode,
      waitedMs: now - waiter.startedAt,
    };
    if (deviceId !== undefined) res.deviceId = deviceId;
    return res;
  }

  private reparkEntry(waiter: Waiter): void {
    const { paths, identity } = waiter;
    const now = this.ctx.clock.now();
    const entry: QueueEntry = {
      ticket: waiter.ticket,
      ownerUuid: identity.ownerUuid,
      pid: identity.pid,
      agentPid: identity.agentPid,
      bootId: identity.bootId,
      mode: waiter.mode,
      enqueuedAt: now,
      heartbeatAt: now,
    };
    if (identity.label !== undefined) entry.label = identity.label;
    if (identity.worktree !== undefined) entry.worktree = identity.worktree;
    if (identity.branch !== undefined) entry.branch = identity.branch;
    if (identity.startedAt !== undefined) entry.startedAt = identity.startedAt;
    enqueue(paths, entry);
  }

  /** Refresh our queue entry's heartbeat while waiting (single-writer, no gate). */
  renewWaiter(waiter: Waiter): void {
    const file = waiter.paths.queueFile(waiter.ticket, waiter.identity.ownerUuid);
    const cur = readJsonOrNull<QueueEntry>(file);
    if (!cur) return; // grant/prune removed it; poll will handle it.
    cur.heartbeatAt = this.ctx.clock.now();
    writeAtomic(file, cur);
  }

  /** Remove our queue entry (on failure/timeout/cancel). */
  async leave(waiter: Waiter): Promise<void> {
    if (waiter.granted) return;
    await withGate(this.ctx, waiter.paths, this.tun(waiter.paths), () => {
      removeQueueEntry(waiter.paths, waiter.ticket, waiter.identity.ownerUuid);
      appendEvent(waiter.paths, {
        ts: this.ctx.clock.now(),
        type: "dequeued",
        resource: waiter.resource,
        owner: waiter.identity.ownerUuid,
        ticket: waiter.ticket,
      });
    });
  }

  private queueInfo(waiter: Waiter): QueueInfo {
    const tun = this.tun(waiter.paths);
    const live = liveSortedQueue(this.ctx, waiter.paths, tun);
    const position = Math.max(0, liveRankOf(live, waiter.identity.ownerUuid));
    return {
      resource: waiter.resource,
      ticket: waiter.ticket,
      ownerUuid: waiter.identity.ownerUuid,
      position,
      waitersAhead: position,
      blockedByApproval: waiter.blockedByApproval,
    };
  }

  /** Full acquire: enter, then poll/wait until granted or give up. */
  async acquire(resource: string, opts: AcquireOptions = {}): Promise<AcquireResult> {
    const waiter = await this.enter(resource, opts);
    const waker = opts.waitForWake ?? defaultWaker;
    const deadline =
      opts.timeoutMs !== undefined ? this.ctx.clock.now() + opts.timeoutMs : null;
    let announced = false;
    try {
      for (;;) {
        const r = await this.poll(waiter);
        if (r) return r;
        if (!opts.wait) {
          throw waiter.blockedByApproval
            ? new HeldForApprovalError(
                `"${resource}" is held for manual approval; run \`mic-lock approve ${resource}\` or --force`,
              )
            : new BusyError(`"${resource}" is busy`);
        }
        if (deadline !== null && this.ctx.clock.now() > deadline) {
          throw new TimeoutError(`timed out after ${opts.timeoutMs}ms waiting for "${resource}"`);
        }
        if (!announced && opts.onQueued) {
          opts.onQueued(this.queueInfo(waiter));
          announced = true;
        }
        const remaining = deadline !== null ? Math.max(0, deadline - this.ctx.clock.now()) : 60_000;
        await waker(Math.min(remaining, 60_000));
        this.renewWaiter(waiter);
      }
    } finally {
      await this.leave(waiter);
    }
  }

  // ---- Renew (keeper / with) ----------------------------------------------

  /**
   * Renew a holder's lease. Fence-checked: if our fence no longer matches, we
   * have been superseded (stolen/stale-broken) and must not touch state.
   */
  async renewHolder(
    resource: string,
    ownerUuid: string,
    fence: number,
    takeover?: { pid: number; startedAt?: string; agentPid?: number },
  ): Promise<RenewResult> {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    let out: RenewResult = { ok: false, superseded: false };
    await withGate(this.ctx, paths, this.tun(paths), () => {
      const meta = readMeta(paths);
      const tun = resolveTunables(this.ctx.stateDir, meta);
      const mine = listHolders(paths).find((h) => h.ownerUuid === ownerUuid);
      if (!mine || mine.fenceToken !== fence) {
        out = { ok: false, superseded: true };
        return;
      }
      const now = this.ctx.clock.now();
      mine.heartbeatAt = now;
      if (mine.mode !== "until-approved") mine.leaseExpiresAt = now + tun.ttlMs;
      if (takeover) {
        mine.pid = takeover.pid;
        if (takeover.startedAt !== undefined) mine.startedAt = takeover.startedAt;
        if (takeover.agentPid !== undefined) mine.agentPid = takeover.agentPid;
      }
      writeHolder(paths, mine);
      out = { ok: true, superseded: false, holder: mine };
    });
    return out;
  }

  // ---- Release / approve ---------------------------------------------------

  async release(resource: string, opts: ReleaseOptions = {}): Promise<ReleaseResult> {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    const released: ReleaseResult["released"] = [];
    await withGate(this.ctx, paths, this.tun(paths), () => {
      const holders = listHolders(paths);
      const now = this.ctx.clock.now();
      let targets: Holder[];
      if (opts.force) {
        targets = opts.slotId ? holders.filter((h) => h.slotId === opts.slotId) : holders;
      } else if (opts.token !== undefined) {
        targets = holders.filter((h) => h.fenceToken === opts.token);
        if (targets.length === 0) {
          if (holders.length > 0) {
            throw new SupersededError(
              `no holder of "${resource}" with fence ${opts.token}; it was superseded`,
            );
          }
          return; // already free — idempotent success
        }
      } else if (opts.ownerUuid) {
        targets = holders.filter((h) => h.ownerUuid === opts.ownerUuid);
      } else if (opts.label) {
        targets = holders.filter((h) => h.label === opts.label);
      } else if (holders.length === 1) {
        targets = holders;
      } else if (holders.length === 0) {
        return;
      } else {
        throw new MicLockError(
          `"${resource}" has ${holders.length} holders; specify --token/--slot/--owner or use --force`,
          ExitCode.USAGE,
        );
      }

      for (const h of targets) {
        retireHolder(paths, h);
        released.push({
          slotId: h.slotId,
          ownerUuid: h.ownerUuid,
          fenceToken: h.fenceToken,
          forced: Boolean(opts.force),
        });
        const ev = {
          ts: now,
          type: opts.force ? ("forced" as const) : ("released" as const),
          resource,
          owner: h.ownerUuid,
          slot: h.slotId,
          fence: h.fenceToken,
        };
        appendEvent(paths, opts.reason ? { ...ev, reason: opts.reason } : ev);
      }
    });
    return { released };
  }

  async approve(
    resource: string,
    opts: { slotId?: string; by?: string } = {},
  ): Promise<ReleaseResult> {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    const released: ReleaseResult["released"] = [];
    await withGate(this.ctx, paths, this.tun(paths), () => {
      const now = this.ctx.clock.now();
      const targets = listHolders(paths).filter(
        (h) => h.mode === "until-approved" && (opts.slotId ? h.slotId === opts.slotId : true),
      );
      if (targets.length === 0) {
        throw new MicLockError(
          `no held-for-approval lock on "${resource}"`,
          ExitCode.ERROR,
        );
      }
      for (const h of targets) {
        retireHolder(paths, h);
        released.push({ slotId: h.slotId, ownerUuid: h.ownerUuid, fenceToken: h.fenceToken, forced: false });
        const ev = {
          ts: now,
          type: "approved" as const,
          resource,
          owner: h.ownerUuid,
          slot: h.slotId,
          fence: h.fenceToken,
        };
        appendEvent(paths, opts.by ? { ...ev, by: opts.by } : ev);
      }
    });
    return { released };
  }

  // ---- Verify / gc ---------------------------------------------------------

  /** Is `token` still the fence of a live holder? Used by children before risky ops. */
  verifyFence(resource: string, token: number): { current: boolean; holder?: Holder } {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    const tun = this.tun(paths);
    const holder = listHolders(paths).find((h) => h.fenceToken === token);
    if (!holder) return { current: false };
    return { current: !isStaleHolder(this.ctx, holder, tun), holder };
  }

  /**
   * Reclaim stale holders, prune crashed waiters, and remove old tombstones for
   * a resource nobody is actively polling. Safe to run any time.
   */
  async gc(
    resource: string,
    tombstoneMaxAgeMs = 24 * 60 * 60 * 1000,
  ): Promise<{ reclaimed: number; prunedWaiters: number; tombstonesRemoved: number }> {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    let reclaimed = 0;
    let prunedWaiters = 0;
    let tombstonesRemoved = 0;
    await withGate(this.ctx, paths, this.tun(paths), () => {
      const tun = resolveTunables(this.ctx.stateDir, readMeta(paths));
      const now = this.ctx.clock.now();
      for (const h of listHolders(paths)) {
        if (isStaleHolder(this.ctx, h, tun)) {
          retireHolder(paths, h);
          appendEvent(paths, {
            ts: now,
            type: "stale-broken",
            resource,
            owner: h.ownerUuid,
            slot: h.slotId,
            fence: h.fenceToken,
          });
          reclaimed++;
        }
      }
      prunedWaiters = pruneDeadWaiters(this.ctx, paths, tun).length;
      for (const f of readdirSafe(paths.deadDir)) {
        const full = join(paths.deadDir, f);
        try {
          if (Date.now() - statSync(full).mtimeMs > tombstoneMaxAgeMs) {
            unlinkQuiet(full);
            tombstonesRemoved++;
          }
        } catch {
          /* ignore */
        }
      }
    });
    return { reclaimed, prunedWaiters, tombstonesRemoved };
  }

  // ---- Read-only views (no gate; tolerant of concurrent writes) -----------

  getStatus(resource: string): ResourceStatus | null {
    const paths = resourcePaths(this.ctx.stateDir, resource);
    const meta = readMeta(paths);
    if (!meta) return null;
    return this.statusFromMeta(resource, paths, meta);
  }

  private statusFromMeta(name: string, paths: ResourcePaths, meta: ResourceMeta): ResourceStatus {
    const tun = resolveTunables(this.ctx.stateDir, meta);
    const now = this.ctx.clock.now();
    const holders: HolderStatus[] = listHolders(paths).map((h) => ({
      ...h,
      live:
        h.mode === "until-approved" ||
        h.leaseExpiresAt === null ||
        this.ctx.liveness.pidAlive(h.pid, h.startedAt, h.bootId),
      stale: isStaleHolder(this.ctx, h, tun),
      ageMs: now - h.acquiredAt,
    }));
    const queue: WaiterStatus[] = listQueue(paths).map((e) => ({
      ...e,
      live: isLiveWaiter(this.ctx, e, tun),
      waitedMs: now - e.enqueuedAt,
    }));
    const activeHolders = holders.filter((h) => !h.stale).length;
    return {
      name: meta.displayName ?? name,
      enc: paths.enc,
      kind: meta.kind,
      capacity: capacityOf(meta),
      free: Math.max(0, capacityOf(meta) - activeHolders),
      holders,
      queue,
      approvalPending: holders.some((h) => h.mode === "until-approved"),
    };
  }

  /** Names of all resources that have been registered/used. */
  listResourceNames(): string[] {
    const dir = statePaths(this.ctx.stateDir).resourcesDir;
    const names: string[] = [];
    for (const enc of readdirSafe(dir)) {
      // The directory name is the encoded resource name; the real display name
      // lives inside meta.json, so read it directly by path.
      const meta = readJsonOrNull<ResourceMeta>(join(dir, enc, "meta.json"));
      if (meta?.displayName) names.push(meta.displayName);
    }
    return names.sort();
  }

  allStatuses(): ResourceStatus[] {
    return this.listResourceNames()
      .map((n) => this.getStatus(n))
      .filter((s): s is ResourceStatus => s !== null);
  }

  slotSummary(resource: string): { total: number; ids: string[] } | null {
    const meta = readMeta(resourcePaths(this.ctx.stateDir, resource));
    if (!meta) return null;
    return { total: capacityOf(meta), ids: slotIds(meta) };
  }
}

function computeDeviceId(meta: ResourceMeta, slot: string): string | undefined {
  if (meta.kind === "pool") return slot;
  if (meta.kind === "mutex") return meta.displayName;
  return `${meta.displayName}#${slot}`;
}
