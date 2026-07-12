import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/eventlog.js";
import { resourcePaths } from "../../src/core/paths.js";
import { tempStateDir } from "../helpers.js";

const BIN = fileURLToPath(new URL("../../dist/bin/mic-lock.js", import.meta.url));

interface WorkerResult {
  code: number | null;
  stderr: string;
}

function runWorker(args: string[]): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

/** Replay the event log and compute peak concurrent holders (overall + per slot). */
function analyze(stateDir: string, resource: string) {
  const events = readEvents(resourcePaths(stateDir, resource));
  const activeSlotByFence = new Map<number, string>();
  let maxConcurrent = 0;
  let maxPerSlot = 0;
  let grants = 0;
  for (const e of events) {
    if (e.type === "granted" && e.fence !== undefined && e.slot !== undefined) {
      activeSlotByFence.set(e.fence, e.slot);
      grants++;
    } else if (
      (e.type === "released" || e.type === "stale-broken" || e.type === "forced" || e.type === "approved") &&
      e.fence !== undefined
    ) {
      activeSlotByFence.delete(e.fence);
    }
    maxConcurrent = Math.max(maxConcurrent, activeSlotByFence.size);
    const perSlot = new Map<string, number>();
    for (const slot of activeSlotByFence.values()) perSlot.set(slot, (perSlot.get(slot) ?? 0) + 1);
    maxPerSlot = Math.max(maxPerSlot, ...(perSlot.size ? [...perSlot.values()] : [0]));
  }
  return { maxConcurrent, maxPerSlot, grants };
}

describe("cross-process concurrency", () => {
  let dir: string;
  let cleanup: () => void;
  let csDir: string;

  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
    csDir = join(dir, "cs");
    mkdirSync(csDir, { recursive: true });
  });
  afterEach(() => cleanup());

  it("never double-acquires a mutex under 10 contending processes", async () => {
    const K = 10;
    const iterations = 8;
    const workers = Array.from({ length: K }, () =>
      runWorker([
        "__hammer",
        "--state-dir",
        dir,
        "--resource",
        "dev",
        "--cs-dir",
        csDir,
        "--iterations",
        String(iterations),
        "--hold-ms",
        "12",
      ]),
    );
    const results = await Promise.all(workers);

    for (const r of results) {
      expect(r.stderr).not.toContain("VIOLATION");
      expect(r.code).toBe(0);
    }
    const { maxConcurrent, maxPerSlot, grants } = analyze(dir, "dev");
    expect(maxConcurrent).toBeLessThanOrEqual(1);
    expect(maxPerSlot).toBeLessThanOrEqual(1);
    expect(grants).toBe(K * iterations);
  });

  it("respects capacity 2 for a semaphore under contention", async () => {
    const K = 10;
    const iterations = 6;
    const workers = Array.from({ length: K }, () =>
      runWorker([
        "__hammer",
        "--state-dir",
        dir,
        "--resource",
        "sem",
        "--cs-dir",
        csDir,
        "--iterations",
        String(iterations),
        "--hold-ms",
        "12",
        "--capacity",
        "2",
      ]),
    );
    const results = await Promise.all(workers);

    for (const r of results) {
      expect(r.stderr).not.toContain("VIOLATION");
      expect(r.code).toBe(0);
    }
    const { maxConcurrent, maxPerSlot } = analyze(dir, "sem");
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThan(1); // capacity actually exercised
    expect(maxPerSlot).toBeLessThanOrEqual(1);
  });

  it("distributes a device pool without collisions", async () => {
    const K = 8;
    const iterations = 5;
    const workers = Array.from({ length: K }, () =>
      runWorker([
        "__hammer",
        "--state-dir",
        dir,
        "--resource",
        "emus",
        "--cs-dir",
        csDir,
        "--iterations",
        String(iterations),
        "--hold-ms",
        "10",
        "--devices",
        "emu-a",
        "emu-b",
        "emu-c",
      ]),
    );
    const results = await Promise.all(workers);
    for (const r of results) {
      expect(r.stderr).not.toContain("VIOLATION");
      expect(r.code).toBe(0);
    }
    const { maxConcurrent, maxPerSlot } = analyze(dir, "emus");
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxPerSlot).toBeLessThanOrEqual(1);
  });

  it("reclaims a SIGKILLed holder so a waiter can proceed", async () => {
    // Short timings so the lease expires quickly after the crash.
    await runWorker([
      "config",
      "register",
      "crashres",
      "--state-dir",
      dir,
      "--ttl",
      "2",
      "--heartbeat",
      "1",
      "--grace",
      "1",
    ]);

    // A `with` holder keeps the lease alive in-process; killing it == a crash.
    const holder: ChildProcess = spawn(
      process.execPath,
      [BIN, "with", "crashres", "--state-dir", dir, "--no-notify", "--", "sleep", "30"],
      { stdio: "ignore" },
    );
    await delay(1500); // let it acquire

    holder.kill("SIGKILL");

    const start = Date.now();
    const waiter = await runWorker([
      "acquire",
      "crashres",
      "--state-dir",
      dir,
      "--wait",
      "--timeout",
      "15000",
      "--ttl",
      "30",
      "--no-notify",
    ]);
    const elapsed = Date.now() - start;

    expect(waiter.code).toBe(0); // reclaimed and granted
    expect(elapsed).toBeLessThan(12000);

    const { grants } = analyze(dir, "crashres");
    expect(grants).toBeGreaterThanOrEqual(2); // original + the reclaiming grant
  });
});
