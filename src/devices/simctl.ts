/** iOS simulator discovery via `xcrun simctl`. */
import { execFileSync } from "node:child_process";
import type { DiscoveredDevice } from "./types.js";

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

interface SimctlList {
  devices: Record<string, SimctlDevice[]>;
}

export function discoverIos(warnings: string[]): { found: boolean; devices: DiscoveredDevice[] } {
  let raw: string;
  try {
    raw = execFileSync("xcrun", ["simctl", "list", "-j", "devices", "available"], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch (err) {
    warnings.push(
      `xcrun simctl not available (${(err as Error).message.split("\n")[0]}). iOS discovery skipped.`,
    );
    return { found: false, devices: [] };
  }

  const devices: DiscoveredDevice[] = [];
  try {
    const parsed = JSON.parse(raw) as SimctlList;
    for (const [runtime, list] of Object.entries(parsed.devices)) {
      const runtimeLabel = runtime.split(".").pop() ?? runtime;
      for (const d of list) {
        if (d.isAvailable === false) continue;
        devices.push({
          id: d.udid,
          name: `${d.name} (${runtimeLabel})`,
          platform: "ios",
          kind: "simulator",
          state: d.state,
          running: d.state === "Booted",
        });
      }
    }
  } catch (err) {
    warnings.push(`failed to parse simctl output: ${(err as Error).message}`);
  }
  return { found: true, devices };
}
