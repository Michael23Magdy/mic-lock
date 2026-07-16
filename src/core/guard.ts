/**
 * Decision logic for the PreToolUse guard (see `mic-lock guard`).
 *
 * Enforcement is deterministic and model-independent: any Bash command that
 * touches a shared test device must go through mic-lock, or it is blocked with
 * instructions. Kept as a pure function so it is unit-testable without stdin.
 *
 * Philosophy: block the clear device-mutating commands; allow read-only
 * discovery and anything already wrapped in mic-lock. A false block is a
 * one-line fix for the agent (wrap in `mic-lock with`), never a hard failure.
 */

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

/** A real mic-lock/mlk invocation (command position, not a mere substring) → allow. */
const WRAPPED = /(?:^|[\n;&|(]|&&|\|\|)\s*(?:sudo\s+)?(?:\w+=\S+\s+)*(?:\S*\/)?(?:mic-lock|mlk)(?:\s|$)/;

/** `adb` invoked as a command (line start / after a separator, optional env/sudo/path). */
const ADB = /(?:^|[\n;&|]|&&|\|\|)\s*(?:sudo\s+)?(?:\w+=\S+\s+)*(?:\S*\/)?adb(?:\s|$)/;
/** `emulator` invoked as a command. */
const EMULATOR = /(?:^|[\n;&|]|&&|\|\|)\s*(?:sudo\s+)?(?:\w+=\S+\s+)*(?:\S*\/)?emulator(?:\s|$)/;
const SIMCTL = /\bxcrun\s+simctl\b|\bsimctl\b/;

/** Read-only adb subcommands that don't need exclusive access. */
const ADB_READONLY =
  /\badb(?:\s+-\S+|\s+-s\s+\S+)*\s+(devices|version|--version|help|get-state|get-serialno|wait-for-device|start-server|kill-server|logcat|bugreport)\b/;
/** Read-only simctl subcommands. */
const SIMCTL_READONLY = /\bsimctl\s+(list|help|getenv|get_app_container)\b/;
/** Read-only emulator flags. */
const EMULATOR_READONLY = /\bemulator\s+(-list-avds|-version|-help|-accel-check|-webcam-list)\b/;

/** Higher-level commands that drive a real device/emulator/simulator. */
const MOBILE_RUN: RegExp[] = [
  /\bflutter\s+(run|drive|install|attach)\b/,
  /\breact-native\s+run-(android|ios)\b/,
  /\bexpo\s+run:(android|ios)\b/,
  /\bmaestro\s+(test|record|start-device)\b/,
  // gradle Android device tasks: connected*, install<Variant>
  /\bgradlew?\b[\s\S]*?\b(connected[A-Za-z]*|install[A-Z][A-Za-z]*)\b/,
  // xcodebuild running on a destination (simulator/device)
  /\bxcodebuild\b[\s\S]*?\b(test|test-without-building|-destination)\b/,
];

const BLOCK_MESSAGE =
  'BLOCKED by mic-lock: this touches a shared test device, and parallel agents\n' +
  'on this machine share a limited number of them. Hold the device lock first.\n\n' +
  'Doing several commands on the device (install, launch, test…)? Take the lock\n' +
  'once and keep it for the whole task — your commands are then allowed until you\n' +
  'release it:\n\n' +
  '  mic-lock acquire <device> --owner "<short task>" --wait\n' +
  '  ...your adb / gradlew / xcodebuild / simctl commands...\n' +
  '  mic-lock release <device>\n\n' +
  'Just one command? Wrap it (auto-releases when it exits, even on crash):\n\n' +
  '  mic-lock with <device> --owner "<short task>" -- <your command>\n\n' +
  'Find <device> with `mic-lock discover` and use the adb serial / simulator UDID\n' +
  '(e.g. emulator-5554) so every agent converges on the same lock. Read-only checks\n' +
  '(adb devices, simctl list, emulator -list-avds) are allowed as-is.\n';

/** Extra context that lets the guard allow commands during an active lock session. */
export interface GuardDeps {
  /** True if the caller's worktree already holds an active device lock. */
  hasActiveHold?: () => boolean;
}

/**
 * Decide whether a tool call should be blocked. Only Bash is inspected.
 *
 * A device-driving command is blocked UNLESS the caller already holds a lock
 * (`deps.hasActiveHold`) — so an agent that took the device once can run many
 * commands against it without re-wrapping each one.
 */
export function evaluateGuard(
  toolName: string | undefined,
  command: string,
  deps?: GuardDeps,
): GuardDecision {
  if (toolName !== "Bash") return { block: false };
  const cmd = command ?? "";
  if (cmd.trim() === "") return { block: false };
  if (WRAPPED.test(cmd)) return { block: false };

  const wouldBlock =
    // Device-driving build/run tools.
    MOBILE_RUN.some((re) => re.test(cmd)) ||
    // Raw simctl / adb / emulator, unless a read-only subcommand or flag.
    (SIMCTL.test(cmd) && !SIMCTL_READONLY.test(cmd)) ||
    (ADB.test(cmd) && !ADB_READONLY.test(cmd)) ||
    (EMULATOR.test(cmd) && !EMULATOR_READONLY.test(cmd));

  if (!wouldBlock) return { block: false };

  // Would block — but if this worktree already holds the device, it is in a
  // coordinated session and may drive the device freely until it releases.
  if (deps?.hasActiveHold?.()) return { block: false };

  return { block: true, reason: BLOCK_MESSAGE };
}
