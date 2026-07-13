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

/** One line of `adb devices -l`, before AVD/boot correlation. */
interface AdbRow {
  serial: string;
  /** Raw adb transport state: "device" | "offline" | "unauthorized" | ... */
  state: string;
  model: string;
  isEmu: boolean;
}

function parseAdbDevices(output: string): AdbRow[] {
  const rows: AdbRow[] = [];
  const lines = output.split("\n").slice(1); // drop "List of devices attached"
  for (const raw of lines) {
    const lineStr = raw.trim();
    if (lineStr.length === 0) continue;
    const parts = lineStr.split(/\s+/);
    const serial = parts[0];
    if (!serial) continue;
    const modelKv = parts.find((p) => p.startsWith("model:"));
    rows.push({
      serial,
      state: parts[1] ?? "unknown",
      model: modelKv ? modelKv.slice("model:".length) : serial,
      isEmu: serial.startsWith("emulator-"),
    });
  }
  return rows;
}

/** First meaningful line of `adb -s <serial> emu avd name` output (drops the trailing OK/KO). */
export function parseAvdName(output: string): string | undefined {
  for (const raw of output.split("\n")) {
    const s = raw.trim();
    if (s.length === 0 || s === "OK" || s === "KO") continue;
    return s;
  }
  return undefined;
}

/** Everything the pure builder needs, so it can be unit-tested without a device. */
export interface AndroidProbe {
  /** Whether `adb devices` succeeded. If false we must NOT assert AVDs are not-booted. */
  adbOk: boolean;
  /** Raw `adb devices -l` output (empty string when adbOk is false). */
  adbDevices: string;
  /** AVD names from `emulator -list-avds`, or null when the emulator binary is absent. */
  listAvds: string[] | null;
  /** A connected emulator's AVD name via `adb -s <serial> emu avd name`. */
  avdNameOf: (serial: string) => string | undefined;
  /** sys.boot_completed === "1" for a connected device; undefined if unreadable. */
  bootCompletedOf: (serial: string) => boolean | undefined;
}

export interface AndroidDiscovery {
  devices: DiscoveredDevice[];
  /** Present emulators we could not map to an AVD name (offline, or name unreadable). */
  unresolvedEmulators: number;
}

/**
 * Pure: turn a probe into discovered devices.
 *
 * The critical correctness rule: a running emulator must never also surface as a
 * phantom "not-booted" row. We correlate each connected `emulator-XXXX` to its
 * AVD name and dedup `emulator -list-avds` against those names — so an already
 * booted emulator is reported once, as booted, and nobody reboots it.
 */
export function buildAndroidDevices(p: AndroidProbe): AndroidDiscovery {
  const devices: DiscoveredDevice[] = [];
  const runningAvdNames = new Set<string>();
  let unresolvedEmulators = 0;

  for (const row of parseAdbDevices(p.adbDevices)) {
    const connected = row.state === "device";

    if (!row.isEmu) {
      devices.push({
        id: row.serial,
        name: row.model,
        platform: "android",
        kind: "physical",
        state: row.state,
        running: connected,
      });
      continue;
    }

    // Emulator: resolve its AVD name (for dedup + a legible label) and real boot
    // state. `emu avd name` needs a live console, so only try it when connected;
    // any emulator we cannot name leaves the not-booted dedup unsafe.
    const avdName = connected ? p.avdNameOf(row.serial) : undefined;
    if (avdName) runningAvdNames.add(avdName);
    else unresolvedEmulators++;

    let state = row.state;
    let bootCompleted: boolean | undefined;
    if (connected) {
      bootCompleted = p.bootCompletedOf(row.serial);
      state = bootCompleted === false ? "booting" : "booted";
    }

    const dev: DiscoveredDevice = {
      id: row.serial,
      name: avdName ?? row.model,
      platform: "android",
      kind: "emulator",
      state,
      running: connected,
    };
    if (avdName) dev.avdName = avdName;
    if (bootCompleted !== undefined) dev.bootCompleted = bootCompleted;
    devices.push(dev);
  }

  // Installed-but-not-booted AVDs are still lockable by name. Only assert this
  // when (a) the adb probe succeeded and (b) we correlated every running
  // emulator — otherwise a running emulator could reappear here as not-booted,
  // which is exactly the false-reboot bug we are fixing.
  if (p.adbOk && p.listAvds && unresolvedEmulators === 0) {
    for (const avd of p.listAvds) {
      if (runningAvdNames.has(avd)) continue;
      devices.push({
        id: avd,
        name: avd,
        platform: "android",
        kind: "emulator",
        state: "not-booted",
        running: false,
        avdName: avd,
      });
    }
  }

  return { devices, unresolvedEmulators };
}

export function discoverAndroid(warnings: string[]): { found: boolean; devices: DiscoveredDevice[] } {
  const adb = findAdb();
  if (!adb) {
    warnings.push(
      "adb not found. Install Android platform-tools or set ANDROID_HOME to enable Android discovery.",
    );
    return { found: false, devices: [] };
  }

  const runAdb = (args: string[], timeoutMs = 5000): string =>
    execFileSync(adb, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });

  let adbDevices = "";
  let adbOk = false;
  try {
    adbDevices = runAdb(["devices", "-l"]);
    adbOk = true;
  } catch (err) {
    warnings.push(`adb devices failed: ${(err as Error).message}`);
  }

  let listAvds: string[] | null = null;
  const emu = findEmulator();
  if (emu) {
    try {
      listAvds = execFileSync(emu, ["-list-avds"], { encoding: "utf8", timeout: 5000 })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      listAvds = null;
    }
  }

  const { devices, unresolvedEmulators } = buildAndroidDevices({
    adbOk,
    adbDevices,
    listAvds,
    avdNameOf: (serial) => {
      try {
        return parseAvdName(runAdb(["-s", serial, "emu", "avd", "name"], 4000));
      } catch {
        return undefined;
      }
    },
    bootCompletedOf: (serial) => {
      try {
        return runAdb(["-s", serial, "shell", "getprop", "sys.boot_completed"], 4000).trim() === "1";
      } catch {
        return undefined;
      }
    },
  });

  if (unresolvedEmulators > 0) {
    warnings.push(
      `could not correlate ${unresolvedEmulators} present emulator(s) to an AVD; ` +
        "not-booted AVDs are hidden this run to avoid a false reboot.",
    );
  }

  return { found: true, devices };
}
