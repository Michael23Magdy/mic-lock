import { ExitCode } from "./exitcodes.js";
import type { ExitCodeValue } from "./exitcodes.js";

/** A typed error carrying the process exit code the CLI should return. */
export class MicLockError extends Error {
  readonly code: ExitCodeValue;
  readonly detail?: unknown;
  constructor(message: string, code: ExitCodeValue = ExitCode.ERROR, detail?: unknown) {
    super(message);
    this.name = "MicLockError";
    this.code = code;
    this.detail = detail;
  }
}

export class BusyError extends MicLockError {
  constructor(message = "resource is busy") {
    super(message, ExitCode.BUSY);
    this.name = "BusyError";
  }
}

export class TimeoutError extends MicLockError {
  constructor(message = "timed out waiting for the lock") {
    super(message, ExitCode.TIMEOUT);
    this.name = "TimeoutError";
  }
}

export class SupersededError extends MicLockError {
  constructor(message = "fence token superseded; the lock is no longer ours") {
    super(message, ExitCode.SUPERSEDED);
    this.name = "SupersededError";
  }
}

export class HeldForApprovalError extends MicLockError {
  constructor(message = "held in until-approved mode; a human must approve or force-release") {
    super(message, ExitCode.HELD_FOR_APPROVAL);
    this.name = "HeldForApprovalError";
  }
}

export class GateTimeoutError extends MicLockError {
  constructor(message = "could not take the coordination gate") {
    super(message, ExitCode.GATE_TIMEOUT);
    this.name = "GateTimeoutError";
  }
}
