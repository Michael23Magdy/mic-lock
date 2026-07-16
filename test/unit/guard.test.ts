import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateGuard } from "../../src/core/guard.js";
import { worktreeHasActiveHold } from "../../src/commands/guard.js";
import { LockEngine } from "../../src/core/lock.js";
import { FakeClock } from "../../src/util/time.js";
import { DEFAULT_TUNABLES } from "../../src/core/tunables.js";
import { FakeLiveness, ident, tempStateDir } from "../helpers.js";

const block = (cmd: string) => expect(evaluateGuard("Bash", cmd).block).toBe(true);
const allow = (cmd: string) => expect(evaluateGuard("Bash", cmd).block).toBe(false);

describe("guard: blocks unwrapped device commands", () => {
  it("blocks adb mutations", () => {
    block("adb install app.apk");
    block("adb -s emulator-5554 install -r app.apk");
    block("adb shell am start -n com.x/.Main");
    block("adb push file /sdcard/");
    block("ANDROID_SERIAL=emulator-5554 adb uninstall com.x");
  });
  it("blocks emulator boot", () => {
    block("emulator -avd Pixel_6");
    block("emulator @Pixel_6 -no-window");
  });
  it("blocks simctl mutations", () => {
    block("xcrun simctl boot ABC-123");
    block("xcrun simctl install booted app.app");
  });
  it("blocks mobile build/run tools", () => {
    block("flutter run");
    block("npx react-native run-android");
    block("react-native run-ios");
    block("expo run:android");
    block("./gradlew connectedAndroidTest");
    block("./gradlew installDebug");
    block("xcodebuild test -destination 'id=ABC'");
    block("maestro test flow.yaml");
  });
  it("blocks when mic-lock/mlk is a bare substring, not a real invocation (#3)", () => {
    block("adb -s emulator-5554 install mlk.apk");
    block("adb install mlk.apk");
    block("adb -s emulator-5554 install /artifacts/mic-lock-build/app.apk");
    block("adb install app.apk # mlk");
    block("adb install app.apk # mic-lock");
    block("cd mlk && adb install app.apk");
  });
});

describe("guard: allows safe / coordinated commands", () => {
  it("allows anything wrapped in mic-lock", () => {
    allow("mic-lock with emulator-5554 -- adb install app.apk");
    allow("mlk with pixel7 -- flutter run");
  });
  it("allows real mic-lock/mlk invocations in various command shapes", () => {
    allow('mlk acquire emulator-5554 --owner "task" --wait');
    allow('mic-lock acquire emulator-5554 --owner "x"');
    allow("mlk release emulator-5554");
    allow("FOO=bar mlk with emulator-5554 -- adb install app.apk");
    allow("./node_modules/.bin/mic-lock with emulator-5554 -- adb install app.apk");
    allow("adb devices && mlk with emulator-5554 -- adb install app.apk");
    allow("(mlk with emulator-5554 -- adb install app.apk)");
  });
  it("allows read-only device queries", () => {
    allow("adb devices");
    allow("adb -s emulator-5554 logcat");
    allow("xcrun simctl list");
    allow("emulator -list-avds");
  });
  it("allows non-device commands", () => {
    allow("echo hello");
    allow("./gradlew test"); // JVM unit tests, no device
    allow("npm run build");
    allow("git commit -m x");
    allow("cat adbkey.pub"); // 'adb' only as a substring, not the command
  });
  it("ignores non-Bash tools", () => {
    expect(evaluateGuard("Read", "adb install app.apk").block).toBe(false);
    expect(evaluateGuard("Bash", "").block).toBe(false);
  });
});

describe("guard: lock-aware session (deps.hasActiveHold)", () => {
  it("allows a device command when the worktree already holds a lock", () => {
    const held = { hasActiveHold: () => true };
    expect(evaluateGuard("Bash", "adb -s emulator-5554 install app.apk", held).block).toBe(false);
    expect(evaluateGuard("Bash", "./gradlew connectedAndroidTest", held).block).toBe(false);
    expect(evaluateGuard("Bash", "xcrun simctl boot ABC-123", held).block).toBe(false);
  });

  it("still blocks a device command when no lock is held", () => {
    const free = { hasActiveHold: () => false };
    expect(evaluateGuard("Bash", "adb -s emulator-5554 install app.apk", free).block).toBe(true);
    expect(evaluateGuard("Bash", "./gradlew connectedAndroidTest", free).block).toBe(true);
  });

  it("never consults the hold check for allowed commands (wrapped / read-only / non-device)", () => {
    let called = false;
    const deps = {
      hasActiveHold: () => {
        called = true;
        return true;
      },
    };
    evaluateGuard("Bash", "mic-lock with emulator-5554 -- adb install app.apk", deps);
    evaluateGuard("Bash", "adb devices", deps);
    evaluateGuard("Bash", "npm run build", deps);
    expect(called).toBe(false);
  });
});

describe("worktreeHasActiveHold (engine integration)", () => {
  let dir: string;
  let cleanup: () => void;
  let clock: FakeClock;
  let liveness: FakeLiveness;
  let engine: LockEngine;

  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
    clock = new FakeClock(1_000);
    liveness = new FakeLiveness();
    engine = new LockEngine({ stateDir: dir, clock, liveness });
  });
  afterEach(() => cleanup());

  async function grant(resource: string, worktree: string, ttlMs?: number) {
    const id = ident(liveness, { worktree, label: "checkout test" });
    const w = await engine.enter(resource, ttlMs !== undefined ? { identity: id, ttlMs } : { identity: id });
    const r = await engine.poll(w);
    expect(r).toBeTruthy();
    return { id, res: r! };
  }

  it("matches the holding worktree and only that worktree", async () => {
    await grant("emulator-5554", "/wt/feature-x");
    expect(worktreeHasActiveHold(engine, "/wt/feature-x")).toBe(true);
    expect(worktreeHasActiveHold(engine, "/wt/other")).toBe(false);
    expect(worktreeHasActiveHold(engine, undefined)).toBe(false);
  });

  it("is false once the lock is released", async () => {
    const { res } = await grant("emulator-5554", "/wt/feature-x");
    await engine.release("emulator-5554", { token: res.fenceToken });
    expect(worktreeHasActiveHold(engine, "/wt/feature-x")).toBe(false);
  });

  it("is false for a crashed session (expired lease + dead pid)", async () => {
    const { id } = await grant("emulator-5554", "/wt/feature-x", DEFAULT_TUNABLES.ttlMs);
    // Agent crashes: its pid dies and the lease expires past the grace window.
    liveness.kill(id.pid);
    clock.advance(DEFAULT_TUNABLES.ttlMs + DEFAULT_TUNABLES.graceMs + 1);
    expect(worktreeHasActiveHold(engine, "/wt/feature-x")).toBe(false);
  });
});
