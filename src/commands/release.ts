import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import type { ReleaseOptions } from "../core/lock.js";

interface ReleaseCliOptions {
  token?: string;
  slot?: string;
  owner?: string;
  force?: boolean;
  reason?: string;
}

export async function releaseAction(
  resource: string,
  options: ReleaseCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const opts: ReleaseOptions = {};
  if (options.token) opts.token = Number(options.token);
  if (options.slot) opts.slotId = options.slot;
  if (options.owner) opts.label = options.owner;
  if (options.force) opts.force = true;
  if (options.reason) opts.reason = options.reason;

  const result = await engine.release(resource, opts);

  if (g.json) {
    emitJson({ ok: true, ...result });
    return;
  }
  if (result.released.length === 0) {
    line(color.dim(`"${resource}" was already free.`));
    return;
  }
  for (const r of result.released) {
    const how = r.forced ? color.yellow("force-released") : color.green("released");
    line(`✓ ${how} "${resource}" slot=${r.slotId} (fence ${r.fenceToken})`);
  }
}
