/** Android device discovery via adb + the emulator tool. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoveredDevice } from "./types.js";

/** Locate the adb binary: PATH, then env SDK roots, then the standard macOS path. */
export function findAdb(): string | null {
  const candidates: string[] = [];
  for (const env of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (env) candidates.push(join(env, "platform-tools", "adb"));
  }
  candidates.push(join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"));
  candidates.push(join(homedir(), "Android", "Sdk", "platform-tools", "adb"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to PATH resolution.
  try {
    execFileSync("adb", ["version"], { stdio: "ignore", timeout: 3000 });
    return "adb";
  } catch {
    return null;
  }
}

function findEmulator(): string | null {
  for (const env of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (env) {
      const p = join(env, "emulator", "emulator");
      if (existsSync(p)) return p;
    }
  }
  const std = join(homedir(), "Library", "Android", "sdk", "emulator", "emulator");
  return existsSync(std) ? std : null;
}

function parseAdbDevices(output: string): DiscoveredDevice[] {
  const out: DiscoveredDevice[] = [];
  const lines = output.split("\n").slice(1); // drop "List of devices attached"
  for (const raw of lines) {
    const lineStr = raw.trim();
    if (lineStr.length === 0) continue;
    const parts = lineStr.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] ?? "unknown";
    if (!serial) continue;
    const modelKv = parts.find((p) => p.startsWith("model:"));
    const model = modelKv ? modelKv.slice("model:".length) : serial;
    const isEmu = serial.startsWith("emulator-");
    out.push({
      id: serial,
      name: model,
      platform: "android",
      kind: isEmu ? "emulator" : "physical",
      state,
      running: state === "device",
    });
  }
  return out;
}

export function discoverAndroid(warnings: string[]): { found: boolean; devices: DiscoveredDevice[] } {
  const adb = findAdb();
  if (!adb) {
    warnings.push(
      "adb not found. Install Android platform-tools or set ANDROID_HOME to enable Android discovery.",
    );
    return { found: false, devices: [] };
  }
  const devices: DiscoveredDevice[] = [];
  try {
    const output = execFileSync(adb, ["devices", "-l"], { encoding: "utf8", timeout: 5000 });
    devices.push(...parseAdbDevices(output));
  } catch (err) {
    warnings.push(`adb devices failed: ${(err as Error).message}`);
  }

  // Offline AVDs (not currently booted) are still lockable by name.
  const emu = findEmulator();
  if (emu) {
    try {
      const avds = execFileSync(emu, ["-list-avds"], { encoding: "utf8", timeout: 5000 })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const runningNames = new Set(devices.map((d) => d.name));
      for (const avd of avds) {
        if (runningNames.has(avd)) continue;
        devices.push({
          id: avd,
          name: avd,
          platform: "android",
          kind: "emulator",
          state: "not-booted",
          running: false,
        });
      }
    } catch {
      /* non-fatal */
    }
  }
  return { found: true, devices };
}
