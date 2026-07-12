import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { ctx } from "./shared.js";
import { unlinkQuiet } from "../core/fsatomic.js";
import { resourcePaths } from "../core/paths.js";
import { ResourceWatcher } from "../events/watcher.js";
import type { AcquireOptions } from "../core/lock.js";

interface HammerCliOptions {
  resource: string;
  csDir: string;
  iterations?: string;
  holdMs?: string;
  capacity?: string;
  devices?: string[];
}

/**
 * Internal stress worker (not user-facing). Repeatedly acquires, occupies its
 * slot behind a create-only "critical section" tripwire, holds briefly, then
 * releases. If two workers ever hold the same slot, the second `wx` open throws
 * and the worker exits 33 — a double-acquire caught at the instant it happens.
 */
export async function hammerAction(options: HammerCliOptions, command: Command): Promise<void> {
  const { engine } = ctx(command);
  const resource = options.resource;
  const iterations = Number(options.iterations ?? 10);
  const holdMs = Number(options.holdMs ?? 15);
  const csDir = options.csDir;
  const paths = resourcePaths(engine.ctx.stateDir, resource);
  const watcher = new ResourceWatcher(paths.root);
  const sab = new Int32Array(new SharedArrayBuffer(4));

  try {
    for (let i = 0; i < iterations; i++) {
      const opts: AcquireOptions = {
        wait: true,
        agentPid: process.pid,
        // Leased (not sticky) so a crashed worker can't wedge the resource, but
        // long enough never to expire during a short hold.
        ttlMs: 30_000,
        waitForWake: (ms) => watcher.wait(ms),
      };
      if (options.capacity) opts.capacity = Number(options.capacity);
      if (options.devices && options.devices.length > 0) opts.deviceIds = options.devices;

      const res = await engine.acquire(resource, opts);

      // Critical-section tripwire, keyed per slot.
      const csFile = join(csDir, `cs-${res.slotId.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
      let fd: number;
      try {
        fd = openSync(csFile, "wx");
      } catch {
        process.stderr.write(
          `VIOLATION double-acquire resource=${resource} slot=${res.slotId} fence=${res.fenceToken} pid=${process.pid}\n`,
        );
        process.exit(33);
      }
      // Hold synchronously for a short random time to create overlap.
      Atomics.wait(sab, 0, 0, Math.max(1, Math.floor(Math.random() * holdMs)));
      closeSync(fd);
      unlinkQuiet(csFile);

      await engine.release(resource, { token: res.fenceToken });
    }
  } finally {
    watcher.close();
  }
  process.exit(0);
}
