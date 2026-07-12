/**
 * Liveness/staleness rules — the heart of crash recovery.
 *
 * The lease is the authority: a holder is stale once its lease has expired past
 * a grace window, regardless of PID state (this catches a hung-but-alive
 * holder). A confirmed-dead renewer PID is an accelerator that lets us reclaim
 * at lease expiry without waiting out the extra grace.
 *
 * `until-approved` holders are NEVER stale: they survive process death and
 * reboot by design and can only be released by a human (`approve`/`--force`).
 */
import type { EngineContext } from "./context.js";
import type { Holder, QueueEntry, Tunables } from "../types.js";

export function isStaleHolder(ctx: EngineContext, holder: Holder, tun: Tunables): boolean {
  // Never auto-reclaimed: a human-approval hold, or a sticky manual lock
  // (leaseExpiresAt === null) that is released explicitly or via --force.
  if (holder.mode === "until-approved") return false;
  if (holder.leaseExpiresAt === null) return false;

  const now = ctx.clock.now();

  // A leased holder from a previous boot is dead: its PID means nothing now.
  if (holder.bootId !== ctx.liveness.bootId()) return true;

  const pidDead = !ctx.liveness.pidAlive(holder.pid, holder.startedAt, holder.bootId);
  // Accelerator: renewer confirmed dead and the lease deadline has passed.
  if (pidDead && now > holder.leaseExpiresAt) return true;
  // Authority: lease expired past the grace window (covers a hung holder).
  if (now > holder.leaseExpiresAt + tun.graceMs) return true;
  return false;
}

export function isLiveWaiter(ctx: EngineContext, entry: QueueEntry, _tun: Tunables): boolean {
  // A waiter is a single blocking process, so its PID is the authority:
  // `kill(pid, 0)` is reliable, and a fresh heartbeat cannot distinguish a
  // just-crashed waiter from a live one — so we must not fall back to it here.
  if (entry.bootId !== ctx.liveness.bootId()) return false;
  return ctx.liveness.pidAlive(entry.pid, entry.startedAt, entry.bootId);
}
