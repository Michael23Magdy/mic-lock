import { cpSync, existsSync, readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { ctx, emitJson, line, color } from "./shared.js";
import { ensureDir, rmrf, writeAtomic } from "../core/fsatomic.js";
import { MicLockError } from "../util/errors.js";
import { ExitCode } from "../util/exitcodes.js";

const HOOK_COMMAND = "mic-lock guard";
const RULE_MARKER = "## Shared test devices — use mic-lock";
const RULE_BODY = `${RULE_MARKER} (enforced)

This machine runs a limited number of emulators / simulators / phones shared by
parallel agents. Before ANY device operation — \`adb install/shell/push\`,
\`emulator\` boot, \`xcrun simctl\`, \`gradlew connected*\`/\`install*\`,
\`xcodebuild test\`, \`flutter\`/\`react-native\`/\`expo run\` — wrap it so you
hold the device lock:

    mic-lock with <device> -- <your command>

Find <device> with \`mic-lock discover\`; use the adb serial or simulator UDID
(e.g. emulator-5554) as the lock name so every agent converges on the same lock.
\`with\` waits its turn when busy and auto-releases when done. A PreToolUse hook
(\`mic-lock guard\`) blocks unwrapped device commands, so this is enforced, not
just advised.
`;

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}
interface Settings {
  hooks?: { PreToolUse?: HookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

function resolveSkillSource(): string {
  const candidates = [
    fileURLToPath(new URL("../../skills/mic-lock", import.meta.url)), // dist/commands -> pkg root
    fileURLToPath(new URL("../../../skills/mic-lock", import.meta.url)), // src/commands (dev)
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "SKILL.md"))) return c;
  }
  throw new MicLockError("could not locate the mic-lock skill to install", ExitCode.ERROR);
}

export interface RunSetupOptions {
  claudeDir: string;
  skillSource: string;
  dryRun?: boolean;
}

export interface SetupResult {
  claudeDir: string;
  skill: "installed" | "would-install";
  hook: "added" | "already-present" | "would-add";
  rule: "added" | "already-present" | "would-add";
}

/** Idempotently install skill + PreToolUse guard hook + CLAUDE.md rule into a .claude dir. */
export function runSetup(o: RunSetupOptions): SetupResult {
  const settingsPath = join(o.claudeDir, "settings.json");
  const claudeMdPath = join(o.claudeDir, "CLAUDE.md");
  const skillDest = join(o.claudeDir, "skills", "mic-lock");

  // --- settings.json (read + merge, never clobber unparseable config) ---
  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8").trim();
    if (raw.length > 0) {
      try {
        settings = JSON.parse(raw) as Settings;
      } catch {
        throw new MicLockError(
          `refusing to edit malformed ${settingsPath} — fix or remove it, then re-run`,
          ExitCode.ERROR,
        );
      }
    }
  }
  const pre = settings.hooks?.PreToolUse ?? [];
  const hookPresent = pre.some((e) =>
    (e.hooks ?? []).some((h) => (h.command ?? "").includes("mic-lock guard") || (h.command ?? "").includes("mic-lock-guard")),
  );

  // --- CLAUDE.md ---
  const rulerPresent =
    existsSync(claudeMdPath) && readFileSync(claudeMdPath, "utf8").includes("mic-lock");

  const result: SetupResult = {
    claudeDir: o.claudeDir,
    skill: o.dryRun ? "would-install" : "installed",
    hook: hookPresent ? "already-present" : o.dryRun ? "would-add" : "added",
    rule: rulerPresent ? "already-present" : o.dryRun ? "would-add" : "added",
  };
  if (o.dryRun) return result;

  // Apply.
  ensureDir(o.claudeDir);

  // 1) skill (copy so it is self-contained and, for --project, committable)
  rmrf(skillDest);
  ensureDir(join(o.claudeDir, "skills"));
  cpSync(o.skillSource, skillDest, { recursive: true });

  // 2) hook
  if (!hookPresent) {
    const nextPre = [...pre, { matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] }];
    settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: nextPre };
    writeAtomic(settingsPath, settings);
  }

  // 3) rule
  if (!rulerPresent) {
    const prefix = existsSync(claudeMdPath) ? "\n" : "";
    appendFileSync(claudeMdPath, prefix + RULE_BODY);
  }

  return result;
}

interface SetupCliOptions {
  user?: boolean;
  project?: string | boolean;
  print?: boolean;
}

export async function setupAction(options: SetupCliOptions, command: Command): Promise<void> {
  const { g } = ctx(command);
  const skillSource = resolveSkillSource();

  let claudeDir: string;
  let scopeLabel: string;
  if (options.project !== undefined) {
    const dir = typeof options.project === "string" && options.project ? resolve(options.project) : process.cwd();
    claudeDir = join(dir, ".claude");
    scopeLabel = `project (${dir})`;
  } else {
    claudeDir = join(homedir(), ".claude");
    scopeLabel = "user (all projects on this machine)";
  }

  const result = runSetup({ claudeDir, skillSource, dryRun: Boolean(options.print) });

  if (g.json) {
    emitJson({ ok: true, scope: scopeLabel, dryRun: Boolean(options.print), ...result });
    return;
  }

  const verb = options.print ? "Would install" : "Installed";
  line(color.green(`✓ mic-lock ${options.print ? "setup (dry run)" : "setup"} — scope: ${scopeLabel}`));
  line(`  ${verb} skill        → ${join(result.claudeDir, "skills/mic-lock")}`);
  line(`  PreToolUse hook     → ${result.hook} (${join(result.claudeDir, "settings.json")})`);
  line(`  device-lock rule    → ${result.rule} (${join(result.claudeDir, "CLAUDE.md")})`);
  if (!options.print) {
    line("");
    line(color.bold("  Enforcement is live. Restart agent sessions so the hook loads."));
    if (options.project !== undefined) {
      line(color.dim("  Commit the .claude/ dir so teammates & other machines get it too."));
      line(color.dim("  (Each machine still needs: npm i -g mic-lock)"));
    } else {
      line(color.dim("  For a specific repo (committable, travels to teammates): mic-lock setup --project"));
    }
    line(color.dim("  Undo: mic-lock setup is reversible — remove the PreToolUse entry + skill dir."));
  }
}
