/**
 * Process/boot liveness. Deciding whether a holder or waiter is "alive" is the
 * crux of crash recovery, so it is an injectable interface (tests substitute a
 * deterministic fake).
 *
 * Rules:
 *   - A record from a *different boot* is always treated as dead: PIDs are not
 *     comparable across reboots.
 *   - Within a boot, `kill(pid, 0)` tests existence, and the process start time
 *     (`ps -o lstart`) defeats PID reuse — a live PID with a different start
 *     time than recorded is a *different* process, so the original is dead.
 */
import { execFileSync } from "node:child_process";

export interface Liveness {
  /** Stable identifier for the current boot session. */
  bootId(): string;
  /** Best-effort process start time for `pid`, or undefined if not found. */
  processStartedAt(pid: number): string | undefined;
  /** True iff `pid` is a live process that matches `startedAt` (when given) and `bootId`. */
  pidAlive(pid: number, startedAt: string | undefined, bootId: string): boolean;
}

function readBootId(): string {
  try {
    // macOS. On Linux we would read /proc/sys/kernel/random/boot_id.
    const out = execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }
  try {
    const out = execFileSync("cat", ["/proc/sys/kernel/random/boot_id"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }
  return "unknown-boot";
}

export class RealLiveness implements Liveness {
  private cachedBootId: string | undefined;

  bootId(): string {
    if (this.cachedBootId === undefined) this.cachedBootId = readBootId();
    return this.cachedBootId;
  }

  processStartedAt(pid: number): string | undefined {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }

  pidAlive(pid: number, startedAt: string | undefined, bootId: string): boolean {
    // Records from another boot are never "alive" (PIDs aren't comparable).
    if (bootId !== this.bootId()) return false;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    let exists = false;
    try {
      process.kill(pid, 0);
      exists = true;
    } catch (err) {
      // EPERM => the process exists but is owned by another user.
      if ((err as NodeJS.ErrnoException).code === "EPERM") exists = true;
      else exists = false;
    }
    if (!exists) return false;
    // Defeat PID reuse: if we recorded a start time, it must still match.
    if (startedAt !== undefined) {
      const cur = this.processStartedAt(pid);
      if (cur !== undefined && cur !== startedAt) return false;
    }
    return true;
  }
}

export const realLiveness = new RealLiveness();
