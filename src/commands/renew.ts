import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { ExitCode } from "../util/exitcodes.js";

interface RenewCliOptions {
  token: string;
}

/** Extend the dead-man timer on a lock you hold. Exit 12 if superseded. */
export async function renewAction(
  resource: string,
  options: RenewCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const token = Number(options.token);
  const { holder } = engine.verifyFence(resource, token);
  if (!holder) {
    if (g.json) emitJson({ ok: false, superseded: true, resource, token });
    else line(color.red(`✗ fence ${token} no longer holds "${resource}" (superseded)`));
    process.exitCode = ExitCode.SUPERSEDED;
    return;
  }
  const r = await engine.renewHolder(resource, holder.ownerUuid, token);
  if (g.json) {
    emitJson({ ok: r.ok, superseded: r.superseded, resource, token });
  } else if (r.ok) {
    line(color.green(`✓ renewed "${resource}" (fence ${token})`));
  } else {
    line(color.red(`✗ could not renew "${resource}" (superseded)`));
  }
  if (r.superseded) process.exitCode = ExitCode.SUPERSEDED;
}
