import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Liveness } from "../src/core/liveness.js";
import type { Identity } from "../src/types.js";

/** A fully controllable liveness oracle for deterministic tests. */
export class FakeLiveness implements Liveness {
  boot = "boot-1";
  private alivePids = new Set<number>();
  private started = new Map<number, string>();

  bootId(): string {
    return this.boot;
  }
  processStartedAt(pid: number): string | undefined {
    return this.started.get(pid);
  }
  pidAlive(pid: number, startedAt: string | undefined, bootId: string): boolean {
    if (bootId !== this.boot) return false;
    if (!this.alivePids.has(pid)) return false;
    if (startedAt !== undefined) {
      const cur = this.started.get(pid);
      if (cur !== undefined && cur !== startedAt) return false;
    }
    return true;
  }

  spawn(pid: number, startedAt?: string): void {
    this.alivePids.add(pid);
    if (startedAt) this.started.set(pid, startedAt);
  }
  kill(pid: number): void {
    this.alivePids.delete(pid);
  }
  reboot(newBoot: string): void {
    this.boot = newBoot;
  }
}

let ownerSeq = 1;
let pidSeq = 10_000;

/** Build a controllable identity and mark its pid alive. */
export function ident(
  liveness: FakeLiveness,
  opts: { pid?: number; label?: string; startedAt?: string } = {},
): Identity {
  const pid = opts.pid ?? pidSeq++;
  const startedAt = opts.startedAt ?? `start-${pid}`;
  liveness.spawn(pid, startedAt);
  const id: Identity = {
    ownerUuid: `owner-${ownerSeq++}`,
    pid,
    agentPid: pid,
    bootId: liveness.boot,
    startedAt,
  };
  if (opts.label !== undefined) id.label = opts.label;
  return id;
}

export function tempStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mlk-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
