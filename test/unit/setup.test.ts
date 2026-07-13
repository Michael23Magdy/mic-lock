import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup } from "../../src/commands/setup.js";
import { tempStateDir } from "../helpers.js";

const skillSource = fileURLToPath(new URL("../../skills/mic-lock", import.meta.url));

describe("mic-lock setup", () => {
  let dir: string;
  let cleanup: () => void;
  let claudeDir: string;
  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
    claudeDir = join(dir, ".claude");
  });
  afterEach(() => cleanup());

  it("installs skill, hook and rule from scratch", () => {
    const r = runSetup({ claudeDir, skillSource });
    expect(r).toMatchObject({ skill: "installed", hook: "added", rule: "added" });
    expect(existsSync(join(claudeDir, "skills/mic-lock/SKILL.md"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const cmds = settings.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("mic-lock guard");
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toContain("mic-lock with <device>");
  });

  it("is idempotent (second run changes nothing)", () => {
    runSetup({ claudeDir, skillSource });
    const r2 = runSetup({ claudeDir, skillSource });
    expect(r2.hook).toBe("already-present");
    expect(r2.rule).toBe("already-present");
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse.length).toBe(1); // not duplicated
  });

  it("preserves existing settings + hooks", () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "my-hook" }] }] } }),
    );
    runSetup({ claudeDir, skillSource });
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus"); // untouched
    expect(settings.hooks.PreToolUse.length).toBe(2); // ours appended
    const cmds = settings.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(cmds).toEqual(expect.arrayContaining(["my-hook", "mic-lock guard"]));
  });

  it("dry run writes nothing", () => {
    const r = runSetup({ claudeDir, skillSource, dryRun: true });
    expect(r.hook).toBe("would-add");
    expect(existsSync(claudeDir)).toBe(false);
  });
});
