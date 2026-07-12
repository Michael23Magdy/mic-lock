import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { ResourceWatcher } from "../events/watcher.js";
import { notify } from "../events/notify.js";
import { formatDuration } from "../util/time.js";
import { resourcePaths } from "../core/paths.js";
import type { AcquireOptions } from "../core/lock.js";

interface AcquireCliOptions {
  wait?: boolean;
  timeout?: string;
  untilApproved?: boolean;
  ttl?: string;
  capacity?: string;
  devices?: string[];
}

export async function acquireAction(
  resource: string,
  options: AcquireCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const mode = options.untilApproved ? "until-approved" : "auto";

  const opts: AcquireOptions = { mode, wait: Boolean(options.wait) };
  if (g.owner) opts.label = g.owner;
  if (options.timeout) opts.timeoutMs = Number(options.timeout);
  // A manual acquire is sticky (held until released) unless a --ttl dead-man
  // timer is given, in which case it auto-reclaims after ttl if not renewed.
  if (options.ttl) opts.ttlMs = Math.round(Number(options.ttl) * 1000);
  if (options.capacity) opts.capacity = Number(options.capacity);
  if (options.devices && options.devices.length > 0) opts.deviceIds = options.devices;

  let watcher: ResourceWatcher | undefined;
  if (opts.wait) {
    watcher = new ResourceWatcher(resourcePaths(engine.ctx.stateDir, resource).root);
    const w = watcher;
    opts.waitForWake = (ms) => w.wait(ms);
    opts.onQueued = (info) => {
      if (g.json) return;
      const extra = info.blockedByApproval ? " (currently held for human approval)" : "";
      line(
        color.yellow(
          `⏳ "${resource}" busy — you are #${info.position + 1} in line${extra}. Waiting…`,
        ),
      );
    };
  }

  try {
    const res = await engine.acquire(resource, opts);

    if (g.json) {
      emitJson({ ok: true, ...res });
      return;
    }
    const dev = res.deviceId ? ` ${color.bold(res.deviceId)}` : "";
    line(color.green(`✓ acquired "${resource}"`) + dev);
    line(
      color.dim(
        `  owner=${res.ownerUuid} fence=${res.fenceToken}` +
          (res.waitedMs > 0 ? ` waited=${formatDuration(res.waitedMs)}` : ""),
      ),
    );
    if (mode === "until-approved") {
      line(
        color.cyan(
          `  🔒 held until you approve. When you have tested it, run: mic-lock approve ${resource}`,
        ),
      );
      notify({ message: `"${resource}" is ready and held for your approval.` });
    } else {
      if (!options.ttl) {
        line(
          color.dim(
            "  held until you release it (a crash won't free it — prefer `mic-lock with` for automated runs).",
          ),
        );
      }
      line(color.dim(`  release with: mic-lock release ${resource} --token ${res.fenceToken}`));
    }
  } finally {
    watcher?.close();
  }
}
