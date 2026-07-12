import type { Command } from "commander";
import { ctx, emitJson, line, color, table } from "./shared.js";
import { discoverAction } from "./discover.js";

interface ListCliOptions {
  devices?: boolean;
  resources?: boolean;
}

export async function listAction(options: ListCliOptions, command: Command): Promise<void> {
  const { g, engine } = ctx(command);

  if (options.devices && !options.resources) {
    await discoverAction({}, command);
    return;
  }

  const statuses = engine.allStatuses();
  if (g.json) {
    emitJson({
      resources: statuses.map((s) => ({
        name: s.name,
        kind: s.kind,
        capacity: s.capacity,
        inUse: s.capacity - s.free,
        free: s.free,
        waiting: s.queue.filter((q) => q.live).length,
        approvalPending: s.approvalPending,
      })),
    });
    return;
  }
  if (statuses.length === 0) {
    line(color.dim("No resources registered yet. Acquire one (mic-lock acquire <name>) or register with config."));
  } else {
    const rows = statuses.map((s) => [
      s.name,
      s.kind,
      `${s.capacity - s.free}/${s.capacity}`,
      String(s.queue.filter((q) => q.live).length),
      s.approvalPending ? color.cyan("yes") : color.dim("no"),
    ]);
    line(table(["resource", "kind", "in-use", "waiting", "approval"], rows));
  }

  if (options.devices) {
    line("");
    line(color.bold("Discovered devices:"));
    await discoverAction({}, command);
  }
}
