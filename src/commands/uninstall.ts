import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { isErrno, rmrf, writeAtomic } from "../core/fsatomic.js";
import {
  RULE_BODY,
  RULE_MARKER,
  isMicLockHookCommand,
  type HookEntry,
  type Settings,
} from "../core/enforcement.js";
import { statePaths } from "../core/paths.js";
import type { LockEngine } from "../core/lock.js";
import { MicLockError } from "../util/errors.js";
import { ExitCode } from "../util/exitcodes.js";

export interface RunUninstallOptions {
  claudeDir: string;
  dryRun?: boolean;
}

type ArtifactState = "removed" | "absent" | "would-remove";

export interface UninstallResult {
  claudeDir: string;
  skill: ArtifactState;
  hook: ArtifactState;
  rule: ArtifactState;
}

/** Does a path exist? Uses lstat so a broken symlink (e.g. from a symlink install) still counts. */
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

/** Parse settings.json and strip the mic-lock guard hook, pruning empty containers. */
function stripHook(settingsPath: string): { present: boolean; next: Settings } {
  if (!existsSync(settingsPath)) return { present: false, next: {} };
  const raw = readFileSync(settingsPath, "utf8").trim();
  if (raw.length === 0) return { present: false, next: {} };
  let settings: Settings;
  try {
    settings = JSON.parse(raw) as Settings;
  } catch {
    throw new MicLockError(
      `refusing to edit malformed ${settingsPath} — fix or remove it, then re-run`,
      ExitCode.ERROR,
    );
  }

  const pre = settings.hooks?.PreToolUse;
  if (!pre || pre.length === 0) return { present: false, next: settings };

  let changed = false;
  const nextPre: HookEntry[] = [];
  for (const entry of pre) {
    const hooks = entry.hooks ?? [];
    const kept = hooks.filter((h) => !isMicLockHookCommand(h.command ?? ""));
    if (kept.length !== hooks.length) changed = true;
    // Drop an entry only if it had hooks and all of them were ours.
    if (hooks.length > 0 && kept.length === 0) continue;
    nextPre.push(kept.length === hooks.length ? entry : { ...entry, hooks: kept });
  }
  if (!changed) return { present: false, next: settings };

  const nextHooks = { ...(settings.hooks ?? {}) };
  if (nextPre.length > 0) nextHooks.PreToolUse = nextPre;
  else delete nextHooks.PreToolUse;

  const next: Settings = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;

  return { present: true, next };
}

/** Locate & strip the device-lock rule block appended to CLAUDE.md. */
function stripRule(claudeMdPath: string): { present: boolean; next: string; remove: boolean } {
  if (!existsSync(claudeMdPath)) return { present: false, next: "", remove: false };
  const content = readFileSync(claudeMdPath, "utf8");

  let stripped: string | null = null;
  const exactIdx = content.indexOf(RULE_BODY);
  if (exactIdx !== -1) {
    // Remove the exact block plus one preceding "\n" separator setup may have added.
    let start = exactIdx;
    if (start > 0 && content[start - 1] === "\n") start -= 1;
    stripped = content.slice(0, start) + content.slice(exactIdx + RULE_BODY.length);
  } else {
    const markerIdx = content.indexOf(RULE_MARKER);
    if (markerIdx !== -1) {
      // Setup only ever appends the block at EOF, so marker..EOF is our block
      // (this fallback also covers a lightly hand-edited body).
      let start = markerIdx;
      if (start > 0 && content[start - 1] === "\n") start -= 1;
      stripped = content.slice(0, start);
    }
  }

  if (stripped === null) return { present: false, next: content, remove: false };

  const trimmed = stripped.replace(/\s+$/, "");
  const remove = trimmed.length === 0;
  return { present: true, next: remove ? "" : trimmed + "\n", remove };
}

/** Idempotently remove the skill + guard hook + CLAUDE.md rule from a .claude dir. */
export function runUninstall(o: RunUninstallOptions): UninstallResult {
  const settingsPath = join(o.claudeDir, "settings.json");
  const claudeMdPath = join(o.claudeDir, "CLAUDE.md");
  const skillDest = join(o.claudeDir, "skills", "mic-lock");

  const hook = stripHook(settingsPath);
  const rule = stripRule(claudeMdPath);
  const skillPresent = pathExists(skillDest);

  const state = (present: boolean): ArtifactState =>
    present ? (o.dryRun ? "would-remove" : "removed") : "absent";

  const result: UninstallResult = {
    claudeDir: o.claudeDir,
    skill: state(skillPresent),
    hook: state(hook.present),
    rule: state(rule.present),
  };
  if (o.dryRun) return result;

  if (hook.present) writeAtomic(settingsPath, hook.next);
  if (rule.present) {
    if (rule.remove) rmrf(claudeMdPath);
    else writeFileSync(claudeMdPath, rule.next, "utf8");
  }
  if (skillPresent) rmrf(skillDest);

  return result;
}

export type LockOutcome =
  | "purged"
  | "absent"
  | "skipped-active"
  | "kept"
  | "would-purge"
  | "would-skip";

export interface PurgeOptions {
  force?: boolean;
  dryRun?: boolean;
}

export interface PurgeResult {
  locks: LockOutcome;
  /** Resources currently in use, when a purge is skipped for safety. */
  busy: string[];
}

/** Names of resources with a live holder or a live waiter right now. */
function activeResources(engine: LockEngine): string[] {
  return engine
    .allStatuses()
    .filter((s) => s.holders.some((h) => !h.stale) || s.queue.some((q) => q.live))
    .map((s) => s.name);
}

/** Remove the shared lock-state dir, unless an agent is mid-run (override with force). */
export function purgeLockState(engine: LockEngine, o: PurgeOptions = {}): PurgeResult {
  const root = statePaths(engine.ctx.stateDir).root;
  const busy = o.force ? [] : activeResources(engine);
  if (busy.length > 0) return { locks: o.dryRun ? "would-skip" : "skipped-active", busy };
  if (!existsSync(root)) return { locks: "absent", busy };
  if (o.dryRun) return { locks: "would-purge", busy };
  rmrf(root);
  return { locks: "purged", busy };
}

interface UninstallCliOptions {
  user?: boolean;
  project?: string | boolean;
  print?: boolean;
  keepLocks?: boolean;
  force?: boolean;
}

const LOCK_LABEL: Record<LockOutcome, string> = {
  purged: "purged",
  absent: "absent (nothing to purge)",
  "skipped-active": "kept — in use by another agent",
  kept: "kept (--keep-locks)",
  "would-purge": "would purge",
  "would-skip": "would keep — in use by another agent",
};

export async function uninstallAction(options: UninstallCliOptions, command: Command): Promise<void> {
  const { g, engine } = ctx(command);

  let claudeDir: string;
  let scopeLabel: string;
  if (options.project !== undefined) {
    const dir =
      typeof options.project === "string" && options.project ? resolve(options.project) : process.cwd();
    claudeDir = join(dir, ".claude");
    scopeLabel = `project (${dir})`;
  } else {
    claudeDir = join(homedir(), ".claude");
    scopeLabel = "user (all projects on this machine)";
  }

  const dryRun = Boolean(options.print);
  const result = runUninstall({ claudeDir, dryRun });

  const purge: PurgeResult = options.keepLocks
    ? { locks: "kept", busy: [] }
    : purgeLockState(engine, { force: options.force, dryRun });

  if (g.json) {
    emitJson({ ok: true, scope: scopeLabel, dryRun, ...result, ...purge });
    return;
  }

  const stateRoot = statePaths(engine.ctx.stateDir).root;
  line(color.green(`✓ mic-lock ${dryRun ? "uninstall (dry run)" : "uninstall"} — scope: ${scopeLabel}`));
  line(`  skill               → ${result.skill} (${join(claudeDir, "skills/mic-lock")})`);
  line(`  PreToolUse hook     → ${result.hook} (${join(claudeDir, "settings.json")})`);
  line(`  device-lock rule    → ${result.rule} (${join(claudeDir, "CLAUDE.md")})`);
  line(`  lock state          → ${LOCK_LABEL[purge.locks]} (${stateRoot})`);

  if (purge.busy.length > 0) {
    line("");
    line(color.yellow(`  ⚠ lock state left intact — in use by: ${purge.busy.join(", ")}`));
    line(color.dim("    Re-run when idle, or pass --force to purge it anyway."));
  }

  if (!dryRun) {
    line("");
    line(color.bold("  Enforcement removed. Restart agent sessions so the hook unloads."));
    line(color.dim("  The mic-lock CLI is still on your PATH — this only reverses `setup`."));
    line(color.dim("  Remove it too with: npm rm -g mic-lock  (npm unlink if you used npm link)."));
    line(color.dim("  A symlink you created by hand isn't tracked here — delete it yourself."));
    line(color.dim("  Re-enable anytime: mic-lock setup"));
  }
}
