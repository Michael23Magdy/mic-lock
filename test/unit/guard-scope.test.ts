import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enforceScoped, projectHasMicLockMarker } from "../../src/commands/guard.js";
import { HOOK_COMMAND, RULE_MARKER } from "../../src/core/enforcement.js";
import { tempStateDir } from "../helpers.js";

describe("enforceScoped", () => {
  it("is false when unset", () => {
    expect(enforceScoped({})).toBe(false);
  });
  it("is false for 'always' or other values", () => {
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "always" })).toBe(false);
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "" })).toBe(false);
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "nope" })).toBe(false);
  });
  it("is true for scoped / marker / project (case-insensitive)", () => {
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "scoped" })).toBe(true);
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "marker" })).toBe(true);
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "project" })).toBe(true);
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "SCOPED" })).toBe(true);
    expect(enforceScoped({ MIC_LOCK_ENFORCE: "Project" })).toBe(true);
  });
});

describe("projectHasMicLockMarker", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
  });
  afterEach(() => cleanup());

  it("is true when the skill SKILL.md is present", () => {
    mkdirSync(join(dir, ".claude", "skills", "mic-lock"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "mic-lock", "SKILL.md"), "# skill\n");
    expect(projectHasMicLockMarker(dir)).toBe(true);
  });

  it("is true when only CLAUDE.md contains the rule marker", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), `intro\n\n${RULE_MARKER} (enforced)\n`);
    expect(projectHasMicLockMarker(dir)).toBe(true);
  });

  it("is true when only settings.json carries a guard hook", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] }] } }),
    );
    expect(projectHasMicLockMarker(dir)).toBe(true);
  });

  it("is false when .claude is absent entirely", () => {
    expect(projectHasMicLockMarker(dir)).toBe(false);
  });

  it("is false for an empty .claude dir", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    expect(projectHasMicLockMarker(dir)).toBe(false);
  });

  it("is false (and does not throw) for malformed settings.json", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{ this is not json");
    expect(() => projectHasMicLockMarker(dir)).not.toThrow();
    expect(projectHasMicLockMarker(dir)).toBe(false);
  });

  it("is false when CLAUDE.md exists but lacks the marker, and settings has no guard hook", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "unrelated notes\n");
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
    );
    expect(projectHasMicLockMarker(dir)).toBe(false);
  });
});
