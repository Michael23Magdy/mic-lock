import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup } from "../../src/commands/setup.js";
import { runUninstall, purgeLockState } from "../../src/commands/uninstall.js";
import { LockEngine } from "../../src/core/lock.js";
import { FakeClock } from "../../src/util/time.js";
import { FakeLiveness, ident, tempStateDir } from "../helpers.js";

const skillSource = fileURLToPath(new URL("../../skills/mic-lock", import.meta.url));

type HookCmd = { command: string };
type HookEntry = { hooks: HookCmd[] };
const commands = (s: { hooks?: { PreToolUse?: HookEntry[] } }): string[] =>
  (s.hooks?.PreToolUse ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command));

describe("mic-lock uninstall — .claude artifacts", () => {
  let dir: string;
  let cleanup: () => void;
  let claudeDir: string;
  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
    claudeDir = join(dir, ".claude");
  });
  afterEach(() => cleanup());

  it("reverses a full setup (skill, hook and rule all removed)", () => {
    runSetup({ claudeDir, skillSource });
    const r = runUninstall({ claudeDir });
    expect(r).toMatchObject({ skill: "removed", hook: "removed", rule: "removed" });
    expect(existsSync(join(claudeDir, "skills/mic-lock"))).toBe(false);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(commands(settings)).not.toContain("mic-lock guard");
    // CLAUDE.md was created solely for the rule, so it is removed entirely.
    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);
  });

  it("is idempotent — nothing installed reports all absent and does not throw", () => {
    const r = runUninstall({ claudeDir });
    expect(r).toMatchObject({ skill: "absent", hook: "absent", rule: "absent" });
  });

  it("preserves unrelated settings and other hooks", () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: "my-hook" }] },
            { matcher: "Bash", hooks: [{ type: "command", command: "mic-lock guard" }] },
          ],
        },
      }),
    );
    const r = runUninstall({ claudeDir });
    expect(r.hook).toBe("removed");
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus"); // untouched
    expect(commands(settings)).toEqual(["my-hook"]); // ours gone, the other kept
  });

  it("keeps user-authored CLAUDE.md content, removing only the rule block", () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# My notes\n\nsome text I wrote\n");
    runSetup({ claudeDir, skillSource }); // appends the rule after the preamble
    const r = runUninstall({ claudeDir });
    expect(r.rule).toBe("removed");
    const md = readFileSync(join(claudeDir, "CLAUDE.md"), "utf8");
    expect(md).toContain("some text I wrote");
    expect(md).not.toContain("mic-lock with <device>");
    expect(md).not.toContain("Shared test devices");
  });

  it("removes a symlinked skill (the link, not its target)", () => {
    // Simulate `scripts/install-skill.mjs`, which symlinks the skill by default.
    const target = join(dir, "skill-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "x");
    mkdirSync(join(claudeDir, "skills"), { recursive: true });
    symlinkSync(target, join(claudeDir, "skills", "mic-lock"));

    const r = runUninstall({ claudeDir });
    expect(r.skill).toBe("removed");
    expect(existsSync(join(claudeDir, "skills", "mic-lock"))).toBe(false);
    expect(existsSync(join(target, "SKILL.md"))).toBe(true); // target left intact
  });

  it("refuses to edit a malformed settings.json", () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{ not json");
    expect(() => runUninstall({ claudeDir })).toThrow(/malformed/);
  });

  it("dry run writes nothing", () => {
    runSetup({ claudeDir, skillSource });
    const r = runUninstall({ claudeDir, dryRun: true });
    expect(r).toMatchObject({ skill: "would-remove", hook: "would-remove", rule: "would-remove" });
    expect(existsSync(join(claudeDir, "skills/mic-lock"))).toBe(true); // still there
  });
});

describe("mic-lock uninstall — lock-state purge", () => {
  let dir: string;
  let cleanup: () => void;
  let clock: FakeClock;
  let liveness: FakeLiveness;
  let engine: LockEngine;
  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
    clock = new FakeClock(1_000);
    liveness = new FakeLiveness();
    engine = new LockEngine({ stateDir: dir, clock, liveness });
  });
  afterEach(() => cleanup());

  it("purges an idle state dir", () => {
    const r = purgeLockState(engine);
    expect(r.locks).toBe("purged");
    expect(existsSync(dir)).toBe(false);
  });

  it("skips a purge while a lock is held, unless forced", async () => {
    const a = ident(liveness);
    const w = await engine.enter("dev", { identity: a });
    await engine.poll(w); // now holding "dev"

    const skipped = purgeLockState(engine);
    expect(skipped.locks).toBe("skipped-active");
    expect(skipped.busy).toContain("dev");
    expect(existsSync(dir)).toBe(true); // untouched

    const forced = purgeLockState(engine, { force: true });
    expect(forced.locks).toBe("purged");
    expect(existsSync(dir)).toBe(false);
  });

  it("dry run reports would-purge without deleting", () => {
    const r = purgeLockState(engine, { dryRun: true });
    expect(r.locks).toBe("would-purge");
    expect(existsSync(dir)).toBe(true);
  });
});
