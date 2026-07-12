import type { Command } from "commander";
import { ctx, emitJson, line, color, table } from "./shared.js";
import { describeOwner } from "../core/identity.js";
import { formatDuration } from "../util/time.js";

export async function queueAction(
  resource: string,
  _options: unknown,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const s = engine.getStatus(resource);
  if (!s) {
    if (g.json) emitJson({ resource, queue: [] });
    else line(color.dim(`No such resource "${resource}".`));
    return;
  }
  if (g.json) {
    emitJson({ resource, queue: s.queue });
    return;
  }
  if (s.queue.length === 0) {
    line(color.dim(`"${resource}" has no waiters.`));
    return;
  }
  const rows = s.queue.map((q, i) => [
    String(i + 1),
    String(q.ticket),
    describeOwner(q),
    formatDuration(q.waitedMs),
    q.mode,
    q.live ? "live" : color.red("dead"),
  ]);
  line(table(["#", "ticket", "owner", "waited", "mode", "state"], rows));
}
