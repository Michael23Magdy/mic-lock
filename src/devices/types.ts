export type DevicePlatform = "android" | "ios";
export type DeviceKind = "emulator" | "simulator" | "physical";

export interface DiscoveredDevice {
  /** Stable id usable as a lock resource: adb serial, simulator UDID, or AVD name. */
  id: string;
  name: string;
  platform: DevicePlatform;
  kind: DeviceKind;
  /** Phase, e.g. "booted", "booting", "not-booted", "device", "offline", "Booted", "Shutdown". */
  state: string;
  /** Whether the device is present and connected (a process exists — do NOT boot it). */
  running: boolean;
  /** Android emulators: the AVD name (constant across boots), when known. */
  avdName?: string;
  /**
   * Emulators/simulators: true once fully booted, false while still booting,
   * undefined when not applicable (physical) or unreadable.
   */
  bootCompleted?: boolean;
}

export interface DiscoverResult {
  devices: DiscoveredDevice[];
  sources: { adb: boolean; simctl: boolean };
  warnings: string[];
}
