import { describe, expect, it } from "vitest";
import { evaluateGuard } from "../../src/core/guard.js";

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
});

describe("guard: allows safe / coordinated commands", () => {
  it("allows anything wrapped in mic-lock", () => {
    allow("mic-lock with emulator-5554 -- adb install app.apk");
    allow("mlk with pixel7 -- flutter run");
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
