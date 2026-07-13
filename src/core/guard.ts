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

/** Already coordinated through mic-lock/mlk anywhere in the command → allow. */
const WRAPPED = /\b(mic-lock|mlk)\b/;

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
  'on this machine share a limited number of them. Re-run it wrapped so you hold\n' +
  'the device lock (it waits its turn if busy and auto-releases when done):\n\n' +
  '  mic-lock with <device> -- <your command>\n\n' +
  'Find <device> with `mic-lock discover` and use the adb serial / simulator UDID\n' +
  '(e.g. emulator-5554) as the lock name so every agent converges on the same lock.\n' +
  'Read-only checks (adb devices, simctl list, emulator -list-avds) are allowed as-is.\n';

/** Decide whether a tool call should be blocked. Only Bash is inspected. */
export function evaluateGuard(toolName: string | undefined, command: string): GuardDecision {
  if (toolName !== "Bash") return { block: false };
  const cmd = command ?? "";
  if (cmd.trim() === "") return { block: false };
  if (WRAPPED.test(cmd)) return { block: false };

  // Device-driving build/run tools.
  if (MOBILE_RUN.some((re) => re.test(cmd))) return blocked();

  // Raw simctl: block unless it's a read-only subcommand.
  if (SIMCTL.test(cmd) && !SIMCTL_READONLY.test(cmd)) return blocked();

  // Raw adb: block unless it's a read-only subcommand.
  if (ADB.test(cmd) && !ADB_READONLY.test(cmd)) return blocked();

  // Raw emulator: block unless it's a read-only flag (e.g. -list-avds).
  if (EMULATOR.test(cmd) && !EMULATOR_READONLY.test(cmd)) return blocked();

  return { block: false };
}

function blocked(): GuardDecision {
  return { block: true, reason: BLOCK_MESSAGE };
}
