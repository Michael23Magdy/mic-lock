/** Aggregate device discovery across Android (adb) and iOS (simctl). */
import { discoverAndroid } from "./adb.js";
import { discoverIos } from "./simctl.js";
import type { DiscoverResult } from "./types.js";

export interface DiscoverOptions {
  adb?: boolean;
  simctl?: boolean;
}

/** Discover devices. With no source flags, probes everything available. */
export function discoverDevices(opts: DiscoverOptions = {}): DiscoverResult {
  const both = !opts.adb && !opts.simctl;
  const warnings: string[] = [];
  const result: DiscoverResult = {
    devices: [],
    sources: { adb: false, simctl: false },
    warnings,
  };

  if (both || opts.adb) {
    const a = discoverAndroid(warnings);
    result.sources.adb = a.found;
    result.devices.push(...a.devices);
  }
  if (both || opts.simctl) {
    const i = discoverIos(warnings);
    result.sources.simctl = i.found;
    result.devices.push(...i.devices);
  }
  return result;
}
