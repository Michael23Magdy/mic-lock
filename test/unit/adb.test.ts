import { describe, expect, it } from "vitest";
import { buildAndroidDevices, parseAvdName, type AndroidProbe } from "../../src/devices/adb.js";

/** A probe with sensible defaults; override per test. */
function probe(over: Partial<AndroidProbe> = {}): AndroidProbe {
  return {
    adbOk: true,
    adbDevices: "List of devices attached\n",
    listAvds: null,
    avdNameOf: () => undefined,
    bootCompletedOf: () => true,
    ...over,
  };
}

const DEVICES_HEADER = "List of devices attached";

describe("buildAndroidDevices: the reboot bug", () => {
  it("reports a running emulator once (booted), with no phantom not-booted row", () => {
    const { devices } = buildAndroidDevices(
      probe({
        adbDevices: `${DEVICES_HEADER}\nemulator-5554\tdevice product:sdk_gphone64 model:sdk_gphone64 transport_id:1\n`,
        listAvds: ["Pixel_6_API_33"],
        avdNameOf: (s) => (s === "emulator-5554" ? "Pixel_6_API_33" : undefined),
        bootCompletedOf: () => true,
      }),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "emulator-5554",
      name: "Pixel_6_API_33",
      avdName: "Pixel_6_API_33",
      kind: "emulator",
      state: "booted",
      running: true,
      bootCompleted: true,
    });
    expect(devices.some((d) => d.state === "not-booted")).toBe(false);
  });

  it("marks a still-booting emulator as booting (present, not ready)", () => {
    const { devices } = buildAndroidDevices(
      probe({
        adbDevices: `${DEVICES_HEADER}\nemulator-5554\tdevice model:sdk\n`,
        listAvds: ["Pixel_6_API_33"],
        avdNameOf: () => "Pixel_6_API_33",
        bootCompletedOf: () => false,
      }),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ state: "booting", running: true, bootCompleted: false });
  });
});

describe("buildAndroidDevices: not-booted enumeration", () => {
  it("lists a genuinely not-booted AVD alongside a running one", () => {
    const { devices } = buildAndroidDevices(
      probe({
        adbDevices: `${DEVICES_HEADER}\nemulator-5554\tdevice model:sdk\n`,
        listAvds: ["Pixel_6_API_33", "Tablet_API_34"],
        avdNameOf: () => "Pixel_6_API_33",
        bootCompletedOf: () => true,
      }),
    );
    const notBooted = devices.filter((d) => d.state === "not-booted");
    expect(notBooted.map((d) => d.id)).toEqual(["Tablet_API_34"]);
  });

  it("does NOT claim AVDs are not-booted when the adb probe failed", () => {
    const { devices } = buildAndroidDevices(
      probe({
        adbOk: false,
        adbDevices: "",
        listAvds: ["Pixel_6_API_33", "Tablet_API_34"],
      }),
    );
    expect(devices).toHaveLength(0);
  });

  it("hides not-booted AVDs when a present emulator cannot be correlated", () => {
    const { devices, unresolvedEmulators } = buildAndroidDevices(
      probe({
        adbDevices: `${DEVICES_HEADER}\nemulator-5554\tdevice model:sdk\n`,
        listAvds: ["Pixel_6_API_33"],
        avdNameOf: () => undefined, // console read failed — cannot map serial -> AVD
        bootCompletedOf: () => true,
      }),
    );
    expect(unresolvedEmulators).toBe(1);
    expect(devices.some((d) => d.state === "not-booted")).toBe(false);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: "emulator-5554", running: true });
  });

  it("treats an offline emulator as uncorrelated (still no phantom not-booted)", () => {
    const { devices, unresolvedEmulators } = buildAndroidDevices(
      probe({
        adbDevices: `${DEVICES_HEADER}\nemulator-5554\toffline\n`,
        listAvds: ["Pixel_6_API_33"],
      }),
    );
    expect(unresolvedEmulators).toBe(1);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: "emulator-5554", state: "offline", running: false });
    expect(devices.some((d) => d.state === "not-booted")).toBe(false);
  });
});

describe("buildAndroidDevices: physical devices", () => {
  it("reports a connected physical device as running", () => {
    const { devices } = buildAndroidDevices(
      probe({ adbDevices: `${DEVICES_HEADER}\nA1B2C3D4\tdevice model:Pixel_7\n`, listAvds: null }),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "A1B2C3D4",
      kind: "physical",
      name: "Pixel_7",
      running: true,
    });
    expect(devices[0]!.avdName).toBeUndefined();
  });
});

describe("parseAvdName", () => {
  it("takes the AVD name and drops the trailing OK", () => {
    expect(parseAvdName("Pixel_6_API_33\nOK\n")).toBe("Pixel_6_API_33");
  });
  it("returns undefined when there is no name", () => {
    expect(parseAvdName("OK\n")).toBeUndefined();
    expect(parseAvdName("")).toBeUndefined();
  });
});
