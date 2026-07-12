/** Shared plumbing for CLI command actions. */
import pc from "picocolors";
import type { Command } from "commander";
import { LockEngine } from "../core/lock.js";
import { defaultStateDir } from "../core/paths.js";
import { setNotifyDisabled } from "../events/notify.js";

export interface GlobalOpts {
  json?: boolean;
  stateDir?: string;
  owner?: string;
  notify?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export interface CliCtx {
  g: GlobalOpts;
  engine: LockEngine;
}

/** Build the per-invocation context, merging global + local options. */
export function ctx(command: Command): CliCtx {
  const g = command.optsWithGlobals() as GlobalOpts;
  if (g.notify === false) setNotifyDisabled(true);
  const engine = new LockEngine({ stateDir: g.stateDir ?? defaultStateDir() });
  return { g, engine };
}

export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

export function errline(s = ""): void {
  process.stderr.write(s + "\n");
}

export const color = pc;

/** Render a simple left-aligned column table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [pc.bold(fmt(headers)), pc.dim(sep), ...rows.map(fmt)].join("\n");
}
