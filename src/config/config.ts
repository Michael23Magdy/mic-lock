/** Global defaults + per-resource metadata IO. */
import { readJsonOrNull, writeAtomic } from "../core/fsatomic.js";
import { statePaths } from "../core/paths.js";
import { mergeTunables } from "../core/tunables.js";
import { globalConfigSchema, resourceMetaSchema } from "./schema.js";
import type { GlobalConfig } from "./schema.js";
import type { ResourcePaths } from "../core/paths.js";
import type { EngineContext } from "../core/context.js";
import type { ResourceKind, ResourceMeta, Tunables } from "../types.js";

export function readGlobalConfig(stateDir: string): GlobalConfig {
  const raw = readJsonOrNull<unknown>(statePaths(stateDir).configFile);
  if (!raw) return {};
  const parsed = globalConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export function writeGlobalConfig(stateDir: string, cfg: GlobalConfig): void {
  writeAtomic(statePaths(stateDir).configFile, cfg);
}

export function readMeta(paths: ResourcePaths): ResourceMeta | null {
  const raw = readJsonOrNull<unknown>(paths.meta);
  if (!raw) return null;
  const parsed = resourceMetaSchema.safeParse(raw);
  return parsed.success ? (parsed.data as ResourceMeta) : null;
}

export function writeMeta(paths: ResourcePaths, meta: ResourceMeta): void {
  writeAtomic(paths.meta, meta);
}

export interface DefaultMetaOptions {
  kind?: ResourceKind;
  capacity?: number;
  deviceIds?: string[];
  defaults?: Partial<Tunables>;
}

/** Build a resource's metadata, defaulting to a simple 1-slot mutex. */
export function buildMeta(
  ctx: EngineContext,
  name: string,
  opts: DefaultMetaOptions = {},
): ResourceMeta {
  const kind =
    opts.kind ??
    (opts.deviceIds && opts.deviceIds.length > 0
      ? "pool"
      : opts.capacity && opts.capacity > 1
        ? "semaphore"
        : "mutex");
  let capacity: number;
  if (kind === "pool") capacity = opts.deviceIds?.length ?? 1;
  else if (kind === "semaphore") capacity = opts.capacity ?? 1;
  else capacity = 1;
  const meta: ResourceMeta = {
    displayName: name,
    kind,
    capacity,
    createdAt: ctx.clock.now(),
  };
  if (opts.deviceIds && opts.deviceIds.length > 0) meta.deviceIds = opts.deviceIds;
  if (opts.defaults) meta.defaults = opts.defaults;
  return meta;
}

/** Effective timing knobs = hardcoded defaults < global config < per-resource. */
export function resolveTunables(stateDir: string, meta: ResourceMeta | null): Tunables {
  const global = readGlobalConfig(stateDir);
  return mergeTunables(global.defaults, meta?.defaults);
}
