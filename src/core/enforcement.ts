/**
 * Shared definitions for the agent-enforcement artifacts that `setup` installs
 * into a `.claude` dir and `uninstall` removes. Kept in one place so the two
 * commands can never drift on what a mic-lock hook/rule looks like.
 */

/** The PreToolUse hook command `setup` writes into settings.json. */
export const HOOK_COMMAND = "mic-lock guard";

/** Heading that opens the device-lock rule appended to CLAUDE.md. */
export const RULE_MARKER = "## Shared test devices — use mic-lock";

/** The full rule block `setup` appends to CLAUDE.md (starts at RULE_MARKER). */
export const RULE_BODY = `${RULE_MARKER} (enforced)

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

export interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

export interface Settings {
  hooks?: { PreToolUse?: HookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * True if a PreToolUse hook command belongs to mic-lock. Accepts both the
 * spaced form we write (`mic-lock guard`) and the hyphenated variant a user
 * might have hand-installed (`mic-lock-guard`).
 */
export function isMicLockHookCommand(command: string): boolean {
  return command.includes("mic-lock guard") || command.includes("mic-lock-guard");
}
