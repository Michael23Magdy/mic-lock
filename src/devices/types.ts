export type DevicePlatform = "android" | "ios";
export type DeviceKind = "emulator" | "simulator" | "physical";

export interface DiscoveredDevice {
  /** Stable id usable as a lock resource: adb serial, simulator UDID, or AVD name. */
  id: string;
  name: string;
  platform: DevicePlatform;
  kind: DeviceKind;
  /** Raw tool state, e.g. "device", "offline", "Booted", "Shutdown", "not-booted". */
  state: string;
  /** Whether the device is currently running and usable for a test. */
  running: boolean;
}

export interface DiscoverResult {
  devices: DiscoveredDevice[];
  sources: { adb: boolean; simctl: boolean };
  warnings: string[];
}
