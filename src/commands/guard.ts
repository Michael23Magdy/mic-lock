import { evaluateGuard } from "../core/guard.js";

/**
 * `mic-lock guard` — a Claude Code PreToolUse hook. Reads the hook JSON on
 * stdin; exits 0 to allow, 2 to block (stderr is surfaced to the agent).
 * Registered automatically by `mic-lock setup`.
 */
export async function guardAction(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stdout.write(
      "mic-lock guard: a PreToolUse hook. It reads hook JSON on stdin and exits\n" +
        "0 (allow) or 2 (block). Install it with `mic-lock setup`.\n",
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let data: { tool_name?: string; tool_input?: { command?: string } };
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0); // never block on malformed input
  }
  const decision = evaluateGuard(data.tool_name, data.tool_input?.command ?? "");
  if (decision.block) {
    process.stderr.write(decision.reason ?? "blocked by mic-lock");
    process.exit(2);
  }
  process.exit(0);
}
