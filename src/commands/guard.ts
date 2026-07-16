import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGuard } from "../core/guard.js";
import { LockEngine } from "../core/lock.js";
import { defaultStateDir } from "../core/paths.js";
import { resolveWorktree } from "../core/identity.js";
import { RULE_MARKER, isMicLockHookCommand, type Settings } from "../core/enforcement.js";

/** True if `worktree` currently holds any live, non-stale device lock. */
export function worktreeHasActiveHold(engine: LockEngine, worktree: string | undefined): boolean {
  if (!worktree) return false;
  for (const status of engine.allStatuses()) {
    for (const h of status.holders) {
      if (h.worktree === worktree && h.live && !h.stale) return true;
    }
  }
  return false;
}

/** Best-effort: does the caller's worktree already hold a device lock? Never throws. */
function currentWorktreeHoldsLock(cwd: string | undefined): boolean {
  try {
    const worktree = resolveWorktree(cwd ?? process.cwd());
    if (!worktree) return false;
    const engine = new LockEngine({ stateDir: process.env.MIC_LOCK_STATE_DIR || defaultStateDir() });
    return worktreeHasActiveHold(engine, worktree);
  } catch {
    // On any failure, report "no hold" so the guard falls back to blocking —
    // never open the gate because of an internal error.
    return false;
  }
}

export function enforceScoped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MIC_LOCK_ENFORCE ?? "").toLowerCase();
  return v === "scoped" || v === "marker" || v === "project";
}

/** True if this project committed a mic-lock marker (i.e. ran `setup --project`). */
export function projectHasMicLockMarker(projectDir: string): boolean {
  const claude = join(projectDir, ".claude");
  if (existsSync(join(claude, "skills", "mic-lock", "SKILL.md"))) return true;
  try {
    if (readFileSync(join(claude, "CLAUDE.md"), "utf8").includes(RULE_MARKER)) return true;
  } catch { /* absent/unreadable */ }
  try {
    const s = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")) as Settings;
    if ((s.hooks?.PreToolUse ?? []).some((e) => (e.hooks ?? []).some((h) => isMicLockHookCommand(h.command ?? "")))) return true;
  } catch { /* absent/malformed */ }
  return false;
}

/**
 * Fail-safe participation check for scoped enforcement: any error is treated as
 * "participating" so the guard keeps enforcing rather than silently opening.
 */
function currentProjectParticipates(cwd: string | undefined): boolean {
  try {
    const root = resolveWorktree(cwd ?? process.cwd()) ?? cwd ?? process.cwd();
    return projectHasMicLockMarker(root);
  } catch { return true; }
}

/**
 * `mic-lock guard` — a Claude Code PreToolUse hook. Reads the hook JSON on
 * stdin; exits 0 to allow, 2 to block (stderr is surfaced to the agent).
 * Registered automatically by `mic-lock setup`.
 */
export async function guardAction(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stdout.write(
      "mic-lock guard: a PreToolUse hook. It reads hook JSON on stdin and exits\n" +
        "0 (allow) or 2 (block). Install it with `mic-lock setup`.\n" +
        "Set MIC_LOCK_ENFORCE=scoped to enforce only in repos that ran `setup --project`.\n",
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let data: { tool_name?: string; tool_input?: { command?: string }; cwd?: string };
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0); // never block on malformed input
  }
  const decision = evaluateGuard(data.tool_name, data.tool_input?.command ?? "", {
    hasActiveHold: () => currentWorktreeHoldsLock(data.cwd),
  });
  if (decision.block) {
    if (enforceScoped() && !currentProjectParticipates(data.cwd)) {
      process.exit(0);
    }
    process.stderr.write(decision.reason ?? "blocked by mic-lock");
    process.exit(2);
  }
  process.exit(0);
}
