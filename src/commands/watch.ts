import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { ResourceWatcher } from "../events/watcher.js";
import { resourcePaths, statePaths } from "../core/paths.js";
import { readEvents } from "../core/eventlog.js";
import type { EventRecord, EventType } from "../types.js";

interface WatchCliOptions {
  events?: string;
}

const TYPE_COLOR: Partial<Record<EventType, (s: string) => string>> = {
  granted: color.green,
  released: color.blue,
  "stale-broken": color.yellow,
  forced: color.red,
  "approval-requested": color.cyan,
  approved: color.cyan,
};

function fmt(e: EventRecord): string {
  const t = new Date(e.ts).toLocaleTimeString();
  const paint = TYPE_COLOR[e.type] ?? ((s: string) => s);
  const parts = [
    e.owner ? `owner=${e.owner.slice(0, 8)}` : "",
    e.slot !== undefined ? `slot=${e.slot}` : "",
    e.fence !== undefined ? `fence=${e.fence}` : "",
    e.ticket !== undefined ? `ticket=${e.ticket}` : "",
    e.by ? `by=${e.by}` : "",
    e.reason ? `reason=${e.reason}` : "",
  ].filter(Boolean);
  return `${color.dim(t)} ${paint(e.type.padEnd(18))} ${color.bold(e.resource)}  ${color.dim(parts.join(" "))}`;
}

export async function watchAction(
  resource: string | undefined,
  options: WatchCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const filter = options.events
    ? new Set(options.events.split(",").map((s) => s.trim()))
    : null;

  const names = () => (resource ? [resource] : engine.listResourceNames());
  const seen = new Map<string, number>();

  const flush = (initial: boolean) => {
    for (const name of names()) {
      const paths = resourcePaths(engine.ctx.stateDir, name);
      const events = readEvents(paths);
      const from = seen.get(name) ?? 0;
      for (let i = from; i < events.length; i++) {
        const e = events[i];
        if (!e) continue;
        if (filter && !filter.has(e.type)) continue;
        if (!initial) {
          if (g.json) emitJson(e);
          else line(fmt(e));
        }
      }
      seen.set(name, events.length);
    }
  };

  // Prime offsets so we only print events from now on.
  flush(true);
  if (!g.json) line(color.dim(`Watching ${resource ?? "all resources"} — Ctrl-C to exit`));

  const watcher = new ResourceWatcher(statePaths(engine.ctx.stateDir).resourcesDir);
  const unsub = watcher.onChange(() => flush(false));
  const poll = setInterval(() => flush(false), 1000);
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
