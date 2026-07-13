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
\`emulator\`/simulator boot, \`xcrun simctl\`, \`gradlew connected*\`/\`install*\`,
\`xcodebuild test\`, \`flutter\`/\`react-native\`/\`expo run\` — you must hold
the device lock.

A device task is usually several commands, so take the lock ONCE and keep it:

    mic-lock acquire <device> --owner "<short task>" --wait
    ...your adb / gradlew / xcodebuild / simctl commands...
    mic-lock release <device>

While you hold it, those commands are allowed; release as soon as you're done.
For a single command, wrap just it (auto-releases on exit):

    mic-lock with <device> --owner "<short task>" -- <your command>

Find <device> with \`mic-lock discover\` and lock the adb serial / simulator UDID
(e.g. emulator-5554) so every agent converges on the same lock — and check its
state there first: never reboot an emulator already shown booted/booting. A
PreToolUse hook (\`mic-lock guard\`) enforces this.
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
