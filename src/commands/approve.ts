import { userInfo } from "node:os";
import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";

interface ApproveCliOptions {
  slot?: string;
}

export async function approveAction(
  resource: string,
  options: ApproveCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  let by = "unknown";
  try {
    by = userInfo().username;
  } catch {
    /* ignore */
  }
  const result = await engine.approve(resource, {
    ...(options.slot ? { slotId: options.slot } : {}),
    by,
  });

  if (g.json) {
    emitJson({ ok: true, approvedBy: by, ...result });
    return;
  }
  for (const r of result.released) {
    line(color.green(`✓ approved "${resource}"`) + color.dim(` slot=${r.slotId} — released for the next agent.`));
  }
}
