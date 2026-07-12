#!/usr/bin/env node
// Symlink (or copy) the mic-lock Claude Code skill into ~/.claude/skills so
// every agent on this machine can use it. Re-runnable.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "skills", "mic-lock");
const skillsDir = join(homedir(), ".claude", "skills");
const target = join(skillsDir, "mic-lock");

if (!existsSync(join(source, "SKILL.md"))) {
  console.error(`✗ skill source not found at ${source}`);
  process.exit(1);
}

mkdirSync(skillsDir, { recursive: true });

if (existsSync(target) || isSymlink(target)) {
  rmSync(target, { recursive: true, force: true });
}

const mode = process.argv.includes("--copy") ? "copy" : "symlink";
try {
  if (mode === "copy") {
    cpSync(source, target, { recursive: true });
  } else {
    symlinkSync(source, target, "dir");
  }
  console.log(`✓ installed mic-lock skill (${mode}) -> ${target}`);
  console.log("  Agents will pick it up on their next Claude Code session.");
} catch (err) {
  console.error(`✗ failed to install skill: ${err.message}`);
  console.error("  Try: node scripts/install-skill.mjs --copy");
  process.exit(1);
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
