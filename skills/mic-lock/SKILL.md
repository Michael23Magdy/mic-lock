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
wait queue, so you take a device, use it, and give it back cleanly.

## Which command do I use?

- **A device task is usually several commands** (install, launch, poke around,
  run a test). Take the lock **once** and keep it for the whole task:
  `acquire` → your commands → `release`. This is the normal case — see below.
- **Exactly one self-contained command?** Wrap just it with `mic-lock with`; it
  auto-releases when the command exits (even on crash).
- **Handing the device to the human to try it?** `acquire --until-approved` —
  only the human frees it.

## The rule (enforced)

Before you touch a shared device — build+install, launch, `adb`, `xcrun simctl`,
`emulator`/simulator boot, or any instrumented/UI/e2e test (`gradlew
connected*`, `xcodebuild test`, `flutter`/`react-native`/`expo run`) — you must
hold a mic-lock on it. A PreToolUse hook blocks those commands until you do.

**Once you hold the lock, the hook lets your device commands through** until you
release — so you do *not* wrap every command. You hold the device for the task
and work normally. If you see the block message, you haven't taken the lock yet:
acquire it (below), don't try to work around the hook.

## Step 1 — pick the device name

Every agent must use the **same name** for a device, or they won't actually
exclude each other. Use the adb serial / simulator UDID from `mic-lock
discover`:

```
$ mic-lock discover
id             name             type              state       lock
emulator-5554  Pixel_6_API_33   android/emulator  booted      free
1A2B3C4D-...   iPhone 15 (18.0) ios/simulator     Shutdown    free
Tablet_API_34  Tablet_API_34    android/emulator  not-booted  free
```

- Lock the **id** (e.g. `emulator-5554`).
- Read **state** before doing anything: `booted` = up and ready; `booting` =
  coming up, wait for it, **do not reboot**; `not-booted` / `Shutdown` = you'll
  need to boot it (only *after* you hold the lock). **Never boot an emulator
  that already shows `booted` or `booting`.**

## Step 2 — hold the device: acquire → work → release

```bash
# Take the device (waits in line if busy). Label who holds it so `status` reads well.
mic-lock acquire emulator-5554 --owner "checkout-flow test" --wait

# Now run as many commands as you need — allowed because you hold the lock:
adb -s emulator-5554 install -r app.apk
adb -s emulator-5554 shell am start -n com.example/.MainActivity
./gradlew connectedAndroidTest

# Give it back the moment you're done — others are queued behind you:
mic-lock release emulator-5554
```

`--wait` queues you fairly and blocks until the device is yours. Hold it only
while you're actively using it; **release promptly**.

> A held device is **not** auto-freed if your session dies. If a hold looks
> abandoned, anyone can see who has it (`mic-lock status`) and recover it with
> `mic-lock release <device> --force`.

## One self-contained command: wrap it (crash-safe)

```bash
mic-lock with emulator-5554 --owner "smoke test" -- \
  bash -c 'adb -s "$MIC_LOCK_DEVICE_ID" install -r app.apk && ./gradlew connectedAndroidTest'
```

`with` waits its turn, heartbeats the lease while the command runs, and releases
on exit — even on crash or Ctrl-C. The locked id is in `$MIC_LOCK_DEVICE_ID`.
Everything after `--` is your command. Use `with` for a single step; use the
acquire→work→release session above whenever you'll issue separate commands.

## Name yourself so `status` is readable

Always pass `--owner "<short task>"` — 2–4 words describing what you're doing
(e.g. `"checkout-flow test"`, `"PR-1234 build"`). Use the **same** label on
every mic-lock command for this device task. There's no automatic session name,
so pick a short human one. To set it once instead of per command, export
`MIC_LOCK_OWNER` in the environment — it's used whenever `--owner` is omitted.
Without a label, `status` can only show your git worktree, which is hard to read.

## Hold for the human to test and approve

When the user wants to **verify the build by hand** before the device passes on:

```bash
mic-lock acquire emulator-5554 --owner "PR-1234 build" --until-approved   # deploy your build
# Then tell the user, verbatim:
#   "Deployed to emulator-5554 and holding it for you. Test it, then run:  mic-lock approve emulator-5554"
```

It will NOT auto-release; only the human frees it. Do not release or force it
yourself — wait for the user to run `mic-lock approve emulator-5554`. (For a
one-shot deploy you can also use `mic-lock with <device> --until-approved -- <deploy cmd>`,
which keeps the device after the command succeeds.)

## Seeing what's going on

```bash
mic-lock status              # who holds what, wait queues, pending approvals
mic-lock status --watch      # live view
mic-lock discover            # real devices (adb / simctl) + state + lock state
mic-lock queue emulator-5554 # the FIFO wait line for one device
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

- **Same name across all agents** — the adb serial / simulator UDID from
  `mic-lock discover`. That's what makes the lock actually exclude others.
- **Check `discover` state first** — never reboot a device already `booted`/`booting`.
- **Always `--owner "<short task>"`**, the same label all through the task.
- **Hold once, work, release** for a multi-command task; `with` for a single
  command; `--until-approved` only when the human will test by hand.
- **Release promptly** — other agents are waiting in line.
