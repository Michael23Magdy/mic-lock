/**
 * Shared types for the mic-lock engine.
 *
 * The design is a two-layer lock (see README "How it works"):
 *   - Layer 1 "gate": a microsecond-held coordination mutex guarding every
 *     state mutation of a resource. Implemented with an atomic create-only
 *     primitive (mkdir).
 *   - Layer 2 "lease": the long-lived holder record carrying a monotonic fence
 *     token, a lease TTL and a heartbeat. Governs who may use the device.
 *
 * Fairness comes from Lamport's Bakery algorithm (FIFO tickets) computed inside
 * the gate; crash-safety from lease expiry + PID/boot liveness; and protection
 * against resurrected "zombie" holders from fencing tokens.
 */

/** How a lock behaves once granted. */
export type LockMode = "auto" | "until-approved";

/** Human-facing holder state. */
export type HolderState = "held" | "held-approval-pending";

/** Shape of a lockable resource. */
export type ResourceKind = "mutex" | "pool" | "semaphore";

/** Identity of the agent/process asking for or holding a lock. */
export interface Identity {
  /** Per-invocation UUID — the canonical ownership + fencing key. */
  ownerUuid: string;
  /** Optional human label (e.g. ticket id) supplied with --owner. */
  label?: string;
  /** git worktree root, if resolvable. */
  worktree?: string;
  /** git branch, if resolvable. */
  branch?: string;
  /** PID responsible for renewing the lease (keeper or `with` runner). */
  pid: number;
  /** PID whose liveness the lock is tied to (the agent/shell). */
  agentPid: number;
  /** kern.bootsessionuuid at acquire time — scopes PID liveness to this boot. */
  bootId: string;
  /** Process start time of `pid` (from `ps -o lstart`), defeats PID reuse. */
  startedAt?: string;
  /** Wrapped command, for `with` mode. */
  cmd?: string;
}

/** A FIFO waiter parked in a resource's queue. */
export interface QueueEntry {
  ticket: number;
  ownerUuid: string;
  label?: string;
  worktree?: string;
  branch?: string;
  pid: number;
  agentPid: number;
  bootId: string;
  startedAt?: string;
  mode: LockMode;
  enqueuedAt: number;
  heartbeatAt: number;
}

/** The lease record for one occupied slot. Absence of the file == free slot. */
export interface Holder {
  ownerUuid: string;
  label?: string;
  worktree?: string;
  branch?: string;
  cmd?: string;
  /** Slot identity: a device id (pool) or "0".."N-1" (semaphore) or "0" (mutex). */
  slotId: string;
  /** Human/device-facing id surfaced to the caller and to `status`. */
  deviceId?: string;
  pid: number;
  agentPid: number;
  bootId: string;
  startedAt?: string;
  /** Monotonic per-resource fence token; strictly increases on every grant. */
  fenceToken: number;
  mode: LockMode;
  state: HolderState;
  /** Populated when the holder was installed via a forced steal. */
  reason?: string;
  acquiredAt: number;
  heartbeatAt: number;
  /** Wall-clock ms deadline; null == never expires (until-approved). */
  leaseExpiresAt: number | null;
}

/** Per-resource timing knobs. All values in milliseconds. */
export interface Tunables {
  /** Lease lifetime for `auto` locks before a heartbeat must renew it. */
  ttlMs: number;
  /** How often a holder/waiter refreshes its heartbeat. */
  heartbeatMs: number;
  /** Extra slack past lease expiry before a lock is considered stale. */
  graceMs: number;
  /** Age past which a held gate is treated as crashed and broken. */
  gateStaleMs: number;
  /** How long acquire will spin trying to take the gate before erroring. */
  gateAcquireTimeoutMs: number;
}

/** On-disk metadata describing a registered resource. */
export interface ResourceMeta {
  displayName: string;
  kind: ResourceKind;
  capacity: number;
  /** For pools: the concrete device ids that form the slot set. */
  deviceIds?: string[];
  defaults?: Partial<Tunables>;
  createdAt: number;
}

/** Monotonic counters, mutated only under the gate. */
export interface Seq {
  nextTicket: number;
  nextFence: number;
}

export type EventType =
  | "queued"
  | "granted"
  | "released"
  | "renewed"
  | "stale-broken"
  | "approval-requested"
  | "approved"
  | "forced"
  | "dequeued";

/** One line of the append-only events.ndjson log. */
export interface EventRecord {
  ts: number;
  type: EventType;
  resource: string;
  owner?: string;
  slot?: string;
  fence?: number;
  ticket?: number;
  by?: string;
  reason?: string;
  detail?: string;
}

/** Result of a successful acquire. */
export interface AcquireResult {
  resource: string;
  slotId: string;
  deviceId?: string;
  fenceToken: number;
  ownerUuid: string;
  mode: LockMode;
  waitedMs: number;
}
