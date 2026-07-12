---
name: mic-lock
description: >-
  Coordinate access to shared test devices (Android emulators, iOS simulators,
  physical phones) when multiple agents run in parallel. Use BEFORE anything
  that touches a device — installing/launching an app, `adb` commands, running
  instrumented/e2e/UI tests, or booting an emulator/simulator — so agents in
  different worktrees don't clobber each other. Acquire a fair lock, wait in
  line when busy, and release when done; optionally hold a device for the human
  to test and approve. Triggers: "test on the emulator", "run on device",
  "adb install", "flutter/react-native run", "xcrun simctl", "device is busy".
---

# mic-lock — shared device locking for parallel agents

Many agents share a machine that can only run one or two emulators/simulators.
If two agents install or drive the same device at once, they corrupt each
other's test runs. **mic-lock** gives each device a fair, first-come lock with a
wait queue, so you take a device, use it, and release it cleanly.

## The rule

> Before you touch a shared device — build+install, launch, `adb`, `xcrun
> simctl`, or any instrumented/UI/e2e test — hold a mic-lock on it. Release as
> soon as you're done.

## Preferred pattern: wrap the command (crash-safe, auto-release)

Put the whole device-using command inside `mic-lock with`. It acquires (waiting
in line if busy), keeps the lease alive while your command runs, and releases on
exit — even if the command crashes or is killed.

```bash
# Android: the locked device serial is exposed as $MIC_LOCK_DEVICE_ID
mic-lock with pixel7 -- bash -c 'adb -s "$MIC_LOCK_DEVICE_ID" install -r app.apk && ./gradlew connectedAndroidTest'

# iOS simulator
mic-lock with iphone15 -- bash -c 'xcrun simctl boot "$MIC_LOCK_DEVICE_ID"; xcodebuild test -destination "id=$MIC_LOCK_DEVICE_ID"'
```

`with` waits for the device by default and exits with your command's exit code.
Everything after `--` is your command; keep its own flags after the `--`.

## Alternative: manual acquire / release

Use this when the work spans multiple separate commands.

```bash
# Wait in line until granted, machine-readable so you can parse it:
OUT=$(mic-lock acquire pixel7 --wait --json)
DEV=$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["deviceId"])')
FENCE=$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["fenceToken"])')

adb -s "$DEV" install -r app.apk
# ... more commands ...

mic-lock release pixel7 --token "$FENCE"     # release as soon as you're done
```

A manual `acquire` is **sticky**: it stays held until you `release` it, so it
survives across separate commands — but a crash will NOT free it automatically.
So: always `release` when done, add `--ttl <sec>` as a dead-man timer if the
work is bounded, and prefer `with` (above) for anything automated, since it
auto-releases even on crash.

## Hold for the human to test and approve

When the user asks to **verify/test the build themselves** before the device is
handed off, hold it in approval mode. It will NOT auto-release; only the human
frees it.

```bash
mic-lock acquire pixel7 --until-approved --json    # deploy your build to the device
# Then tell the user, verbatim:
#   "Deployed to pixel7 and holding it for you. Test it, then run:  mic-lock approve pixel7"
```

Do not release or force it yourself — wait for the user to run `mic-lock approve
pixel7` (which frees it for the next agent).

## Seeing what's going on

```bash
mic-lock status              # who holds what, wait queues, pending approvals
mic-lock status --watch      # live view
mic-lock discover            # list real devices (adb / simctl) + their lock state
mic-lock queue pixel7        # the FIFO wait line for one device
```

## Exit codes (branch on these, don't scrape text)

| code | meaning | what to do |
|------|---------|------------|
| 0 | acquired / ok | proceed |
| 10 | busy (you passed no `--wait`) | retry with `--wait`, or do other work |
| 11 | timed out waiting | try later; report to the user if blocking |
| 12 | superseded (you lost the lock) | stop touching the device immediately |
| 13 | held for human approval | wait; tell the user to run `mic-lock approve` |

## Conventions

- Use a **stable resource name per device** so all agents converge on the same
  lock. Good names: the device the team refers to (`pixel7`, `iphone15`), an adb
  serial, or a simulator UDID. Get real ids from `mic-lock discover`.
- Label yourself so `status` is legible: add `--owner <ticket-id>`.
- Prefer `with` for automated runs; use `--until-approved` only when the user
  explicitly wants to test by hand.
- Release promptly — other agents are waiting in line.
