import type { Command } from "commander";
import { ctx, emitJson, line, color, table, errline } from "./shared.js";
import { discoverDevices } from "../devices/registry.js";
import { describeOwner } from "../core/identity.js";

interface DiscoverCliOptions {
  adb?: boolean;
  simctl?: boolean;
}

export async function discoverAction(
  options: DiscoverCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const result = discoverDevices({
    ...(options.adb ? { adb: true } : {}),
    ...(options.simctl ? { simctl: true } : {}),
  });

  const annotated = result.devices.map((d) => {
    const s = engine.getStatus(d.id);
    const activeHolders = s ? s.holders.filter((h) => !h.stale) : [];
    return {
      ...d,
      locked: activeHolders.length > 0,
      lockedBy: activeHolders.map((h) => describeOwner(h)),
      approvalPending: s?.approvalPending ?? false,
    };
  });

  if (g.json) {
    emitJson({ ...result, devices: annotated });
    return;
  }
  for (const w of result.warnings) errline(color.yellow(`! ${w}`));
  if (annotated.length === 0) {
    line(color.dim("No devices discovered."));
    return;
  }
  const rows = annotated.map((d) => [
    d.id,
    d.name,
    `${d.platform}/${d.kind}`,
    d.running ? color.green("running") : color.dim(d.state),
    d.approvalPending
      ? color.cyan("approval-hold")
      : d.locked
        ? color.yellow(`locked by ${d.lockedBy.join(", ")}`)
        : color.dim("free"),
  ]);
  line(table(["id", "name", "type", "state", "lock"], rows));
}
