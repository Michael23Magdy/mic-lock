import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";

export async function gcAction(
  resource: string | undefined,
  _options: unknown,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const targets = resource ? [resource] : engine.listResourceNames();
  const results: Array<{ resource: string; reclaimed: number; prunedWaiters: number; tombstonesRemoved: number }> = [];
  for (const name of targets) {
    const r = await engine.gc(name);
    results.push({ resource: name, ...r });
  }

  if (g.json) {
    emitJson({ ok: true, results });
    return;
  }
  const totals = results.reduce(
    (a, r) => ({
      reclaimed: a.reclaimed + r.reclaimed,
      prunedWaiters: a.prunedWaiters + r.prunedWaiters,
      tombstonesRemoved: a.tombstonesRemoved + r.tombstonesRemoved,
    }),
    { reclaimed: 0, prunedWaiters: 0, tombstonesRemoved: 0 },
  );
  line(
    color.green("✓ gc done") +
      color.dim(
        ` — reclaimed ${totals.reclaimed} stale lock(s), pruned ${totals.prunedWaiters} dead waiter(s), removed ${totals.tombstonesRemoved} tombstone(s) across ${targets.length} resource(s)`,
      ),
  );
}
