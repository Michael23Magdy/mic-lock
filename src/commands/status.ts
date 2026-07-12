import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { ResourceWatcher } from "../events/watcher.js";
import { statePaths } from "../core/paths.js";
import { describeOwner } from "../core/identity.js";
import { formatDuration } from "../util/time.js";
import type { LockEngine, ResourceStatus } from "../core/lock.js";

interface StatusCliOptions {
  watch?: boolean;
  all?: boolean;
}

function renderResource(s: ResourceStatus): string {
  const inUse = s.holders.filter((h) => !h.stale).length;
  const head =
    color.bold(s.name) +
    color.dim(`  [${s.kind} ${inUse}/${s.capacity} in use]`) +
    (s.approvalPending ? color.cyan("  🔒 approval pending") : "");
  const out: string[] = [head];

  for (const h of s.holders) {
    const who = describeOwner(h);
    const lease =
      h.leaseExpiresAt === null
        ? "∞"
        : formatDuration(Math.max(0, h.leaseExpiresAt - (h.acquiredAt + h.ageMs)));
    const tag = h.mode === "until-approved" ? color.cyan("APPROVAL") : color.green("HELD");
    const flags = [
      h.deviceId ? `device=${h.deviceId}` : `slot=${h.slotId}`,
      `by=${who}`,
      `pid=${h.pid}`,
      `age=${formatDuration(h.ageMs)}`,
      `fence=${h.fenceToken}`,
      `lease=${lease}`,
      h.stale ? color.red("STALE") : "",
      // Only meaningful for a leased holder whose renewer has died.
      h.leaseExpiresAt !== null && !h.live && h.mode !== "until-approved"
        ? color.yellow("pid-dead")
        : "",
    ].filter(Boolean);
    out.push(`  ${tag}  ${flags.join("  ")}`);
    if (h.reason) out.push(color.dim(`        reason: ${h.reason}`));
  }

  const live = s.queue.filter((q) => q.live);
  if (live.length > 0) {
    out.push(color.dim(`  waiting (${live.length}):`));
    live.forEach((q, i) => {
      out.push(
        color.dim(
          `    #${i + 1} ticket=${q.ticket} by=${describeOwner(q)} waited=${formatDuration(q.waitedMs)}${q.mode === "until-approved" ? " [wants-approval-hold]" : ""}`,
        ),
      );
    });
  }
  if (s.holders.length === 0 && live.length === 0) out.push(color.dim("  (free, no waiters)"));
  return out.join("\n");
}

function selectStatuses(engine: LockEngine, resource: string | undefined): ResourceStatus[] {
  if (resource) {
    const s = engine.getStatus(resource);
    return s ? [s] : [];
  }
  return engine.allStatuses();
}

export async function statusAction(
  resource: string | undefined,
  options: StatusCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);

  const renderOnce = () => {
    const statuses = selectStatuses(engine, resource);
    if (g.json) {
      emitJson({ resources: statuses });
      return;
    }
    if (statuses.length === 0) {
      line(color.dim(resource ? `No such resource "${resource}".` : "No resources yet."));
      return;
    }
    line(statuses.map(renderResource).join("\n\n"));
  };

  if (!options.watch) {
    renderOnce();
    return;
  }

  // Live view: clear + redraw on any state change, with a poll backstop.
  const watcher = new ResourceWatcher(statePaths(engine.ctx.stateDir).resourcesDir);
  const draw = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    line(color.dim(`mic-lock — live status (Ctrl-C to exit) — ${new Date().toLocaleTimeString()}`));
    line("");
    renderOnce();
  };
  draw();
  const unsub = watcher.onChange(draw);
  const poll = setInterval(draw, 1000);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearInterval(poll);
      unsub();
      watcher.close();
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}
