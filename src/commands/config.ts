import type { Command } from "commander";
import { ctx, emitJson, line, color, table } from "./shared.js";
import { resourcePaths } from "../core/paths.js";
import {
  buildMeta,
  readGlobalConfig,
  readMeta,
  resolveTunables,
  writeGlobalConfig,
  writeMeta,
} from "../config/config.js";
import { DEFAULT_TUNABLES } from "../core/tunables.js";
import { MicLockError } from "../util/errors.js";
import { ExitCode } from "../util/exitcodes.js";
import type { ResourceKind, Tunables } from "../types.js";

interface RegisterCliOptions {
  kind?: ResourceKind;
  capacity?: string;
  deviceIds?: string[];
  ttl?: string;
  heartbeat?: string;
  grace?: string;
}

function tunablesFromOpts(o: {
  ttl?: string;
  heartbeat?: string;
  grace?: string;
}): Partial<Tunables> {
  const t: Partial<Tunables> = {};
  if (o.ttl) t.ttlMs = Math.round(Number(o.ttl) * 1000);
  if (o.heartbeat) t.heartbeatMs = Math.round(Number(o.heartbeat) * 1000);
  if (o.grace) t.graceMs = Math.round(Number(o.grace) * 1000);
  return t;
}

export async function configRegisterAction(
  name: string,
  options: RegisterCliOptions,
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const paths = resourcePaths(engine.ctx.stateDir, name);
  const defaults = tunablesFromOpts(options);
  const meta = buildMeta(engine.ctx, name, {
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.capacity ? { capacity: Number(options.capacity) } : {}),
    ...(options.deviceIds && options.deviceIds.length > 0 ? { deviceIds: options.deviceIds } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
  });
  if (meta.kind === "pool" && (!meta.deviceIds || meta.deviceIds.length === 0)) {
    throw new MicLockError("a pool needs --device-ids <id...>", ExitCode.USAGE);
  }
  writeMeta(paths, meta);
  if (g.json) emitJson({ ok: true, resource: name, meta });
  else
    line(
      color.green(`✓ registered "${name}"`) +
        color.dim(` kind=${meta.kind} capacity=${meta.capacity}${meta.deviceIds ? ` devices=[${meta.deviceIds.join(", ")}]` : ""}`),
    );
}

export async function configListAction(_options: unknown, command: Command): Promise<void> {
  const { g, engine } = ctx(command);
  const names = engine.listResourceNames();
  const global = readGlobalConfig(engine.ctx.stateDir);
  const resources = names.map((n) => {
    const paths = resourcePaths(engine.ctx.stateDir, n);
    const meta = readMeta(paths);
    return { name: n, meta, tunables: resolveTunables(engine.ctx.stateDir, meta) };
  });

  if (g.json) {
    emitJson({ defaults: { ...DEFAULT_TUNABLES, ...global.defaults }, resources });
    return;
  }
  line(color.bold("Global defaults (ms):"));
  const eff = { ...DEFAULT_TUNABLES, ...global.defaults };
  line(color.dim(`  ttl=${eff.ttlMs} heartbeat=${eff.heartbeatMs} grace=${eff.graceMs} gateStale=${eff.gateStaleMs} gateAcquireTimeout=${eff.gateAcquireTimeoutMs}`));
  line("");
  if (resources.length === 0) {
    line(color.dim("No resources registered."));
    return;
  }
  const rows = resources.map((r) => [
    r.name,
    r.meta?.kind ?? "?",
    String(r.meta?.capacity ?? "?"),
    r.meta?.deviceIds ? r.meta.deviceIds.join(",") : "-",
    `${r.tunables.ttlMs}/${r.tunables.heartbeatMs}/${r.tunables.graceMs}`,
  ]);
  line(table(["resource", "kind", "cap", "devices", "ttl/hb/grace"], rows));
}

export async function configSetDefaultsAction(
  options: { ttl?: string; heartbeat?: string; grace?: string },
  command: Command,
): Promise<void> {
  const { g, engine } = ctx(command);
  const patch = tunablesFromOpts(options);
  if (Object.keys(patch).length === 0) {
    throw new MicLockError("nothing to set; pass --ttl/--heartbeat/--grace (seconds)", ExitCode.USAGE);
  }
  const cfg = readGlobalConfig(engine.ctx.stateDir);
  cfg.defaults = { ...cfg.defaults, ...patch };
  writeGlobalConfig(engine.ctx.stateDir, cfg);
  if (g.json) emitJson({ ok: true, defaults: cfg.defaults });
  else line(color.green("✓ updated global defaults"));
}
