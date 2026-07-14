import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Command } from "commander";
import { ctx, line, color, errline } from "./shared.js";
import { ResourceWatcher } from "../events/watcher.js";
import { resourcePaths } from "../core/paths.js";
import { readMeta, resolveTunables } from "../config/config.js";
import { notify } from "../events/notify.js";
import { describeOwner } from "../core/identity.js";
import { ExitCode } from "../util/exitcodes.js";
import type { AcquireOptions } from "../core/lock.js";

interface WithCliOptions {
  wait?: boolean; // --no-wait => false
  timeout?: string;
  untilApproved?: boolean;
  ttl?: string;
}

/**
 * Acquire, run a child command while heartbeating the lease in-process, then
 * release on any exit. This ties the lock to a concrete process, so a crash
 * (even SIGKILL) frees the device once the lease expires — the crash-safe path.
 */
export async function withAction(
  resource: string,
  cmdParts: string[],
  options: WithCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  if (!cmdParts || cmdParts.length === 0) {
    errline(color.red("error: no command given. Usage: mic-lock with <resource> -- <cmd> [args...]"));
    process.exitCode = ExitCode.USAGE;
    return;
  }

  const mode = options.untilApproved ? "until-approved" : "auto";
  const paths = resourcePaths(engine.ctx.stateDir, resource);
  const watcher = new ResourceWatcher(paths.root);

  const tun = resolveTunables(engine.ctx.stateDir, readMeta(paths));
  const acquireOpts: AcquireOptions = {
    mode,
    wait: options.wait !== false,
    agentPid: process.pid, // this process is both renewer and the "agent"
    cmd: cmdParts.join(" "),
    waitForWake: (ms) => watcher.wait(ms),
    onQueued: (info) => {
      if (!g.json)
        line(color.yellow(`⏳ "${resource}" busy — waiting (position #${info.position + 1})…`));
    },
  };
  if (g.owner) acquireOpts.label = g.owner;
  if (options.timeout) acquireOpts.timeoutMs = Number(options.timeout);
  // `with` always takes a lease and heartbeats it below, so a crash (even
  // SIGKILL) frees the device once the lease expires. until-approved holds
  // deliberately stay put for the human instead.
  if (mode !== "until-approved") {
    acquireOpts.ttlMs = options.ttl ? Math.round(Number(options.ttl) * 1000) : tun.ttlMs;
  }

  const res = await engine.acquire(resource, acquireOpts);
  watcher.close();

  // The legible owner label exactly as `status` shows it (label > worktree > uuid),
  // so the wrapped command — and anything it spawns — sees who holds the device.
  const holder = engine.getStatus(resource)?.holders.find((h) => h.fenceToken === res.fenceToken);
  const ownerLabel = holder ? describeOwner(holder) : (g.owner ?? res.ownerUuid);

  if (!g.json) {
    line(color.green(`✓ acquired "${resource}"`) + (res.deviceId ? ` ${color.bold(res.deviceId)}` : ""));
    line(color.dim(`  running: ${cmdParts.join(" ")}`));
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(hb);
    try {
      await engine.release(resource, { token: res.fenceToken });
    } catch {
      /* best effort */
    }
  };

  // In-process heartbeat. If we are superseded (force-stolen), stop the child
  // so it cannot clobber a device that now belongs to someone else.
  const hb = setInterval(() => {
    void engine.renewHolder(resource, res.ownerUuid, res.fenceToken).then((r) => {
      if (r.superseded && !released) {
        errline(
          color.red(`✗ lost lock on "${resource}" (force-released by someone else) — stopping command`),
        );
        notify({ message: `Your lock on "${resource}" was taken; the running command was stopped.` });
        released = true;
        clearInterval(hb);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        process.exitCode = ExitCode.SUPERSEDED;
      }
    });
  }, Math.max(500, Math.floor(tun.heartbeatMs)));
  hb.unref?.();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MIC_LOCK_RESOURCE: resource,
    MIC_LOCK_OWNER: ownerLabel,
    MIC_LOCK_FENCE_TOKEN: String(res.fenceToken),
    MIC_LOCK_SLOT: res.slotId,
    MIC_LOCK_STATE_DIR: engine.ctx.stateDir,
  };
  if (res.deviceId) childEnv.MIC_LOCK_DEVICE_ID = res.deviceId;

  const child: ChildProcess = spawn(cmdParts[0] as string, cmdParts.slice(1), {
    stdio: "inherit",
    env: childEnv,
  });

  const forward = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  await new Promise<void>((resolve) => {
    child.on("error", async (err) => {
      errline(color.red(`✗ failed to run command: ${(err as Error).message}`));
      await release();
      process.exitCode = 127;
      resolve();
    });
    child.on("exit", async (code, signal) => {
      const exit = code ?? (signal ? 128 : 0);
      if (mode === "until-approved" && exit === 0) {
        // Deliberately keep the device after a successful run: the human tests
        // the build, then frees it with `mic-lock approve`. Just stop our
        // heartbeat and stand down (do NOT release). A failed run falls through
        // to release below so we never strand the device on a broken build.
        released = true;
        clearInterval(hb);
        if (!g.json) {
          line(
            color.cyan(
              `  🔒 "${resource}" is held for you. When you've tested it, run: mic-lock approve ${resource}`,
            ),
          );
        }
        notify({ message: `"${resource}" is ready and held for your approval.` });
      } else {
        await release();
      }
      if (process.exitCode === undefined || process.exitCode === 0) {
        process.exitCode = exit;
      }
      resolve();
    });
  });

  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
