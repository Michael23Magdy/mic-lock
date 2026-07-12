import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { ExitCode } from "../util/exitcodes.js";

interface VerifyCliOptions {
  token: string;
}

/**
 * Assert that a fence token still owns a live slot. Exit 0 = current, 12 =
 * superseded. Children (under `with`) call this before a risky device op.
 */
export async function verifyAction(
  resource: string,
  options: VerifyCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const token = Number(options.token);
  const { current, holder } = engine.verifyFence(resource, token);

  if (g.json) {
    emitJson({ ok: current, resource, token, current, ...(holder ? { deviceId: holder.deviceId } : {}) });
  } else if (current) {
    line(color.green(`✓ fence ${token} is current on "${resource}"`));
  } else {
    line(color.red(`✗ fence ${token} is NOT current on "${resource}" (superseded)`));
  }
  if (!current) process.exitCode = ExitCode.SUPERSEDED;
}
