/**
 * mic-lock library entry point.
 *
 * The engine is usable programmatically, not just via the CLI. Nothing here
 * calls process.exit or prints; wire in your own clock/liveness for tests.
 */
export { LockEngine } from "./core/lock.js";
export type {
  AcquireOptions,
  ReleaseOptions,
  ReleaseResult,
  RenewResult,
  ResourceStatus,
  HolderStatus,
  WaiterStatus,
  Waiter,
  QueueInfo,
  Waker,
  LockEngineOptions,
} from "./core/lock.js";
export { DEFAULT_TUNABLES, mergeTunables } from "./core/tunables.js";
export { defaultStateDir } from "./core/paths.js";
export { RealLiveness, realLiveness } from "./core/liveness.js";
export type { Liveness } from "./core/liveness.js";
export { realClock, FakeClock } from "./util/time.js";
export type { Clock } from "./util/time.js";
export { ExitCode } from "./util/exitcodes.js";
export {
  MicLockError,
  BusyError,
  TimeoutError,
  SupersededError,
  HeldForApprovalError,
  GateTimeoutError,
} from "./util/errors.js";
export * from "./types.js";
