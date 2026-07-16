# mic-lock

**A local, serverless lock for the handful of test devices a machine can run — built for many AI coding agents sharing one laptop's emulators, simulators, and phones.**

You have several agents working different tickets in different git worktrees on
one machine. They all want to test on the *same* emulator/simulator/device (the
machine can only run a couple at a time), and they clobber each other's installs
and test state. mic-lock makes each device a **fair, first-come lock**: an agent
that starts using a device acquires it; anyone else **sees it's busy, waits in a
FIFO queue, and is notified the instant it frees**. Optionally, a device can be
**held until a human tests and approves** it before the next agent gets in.

No server, no daemon, no Redis. Just a CLI and a shared state directory in your
home folder.

> **Why it exists:** tools that offer a *fair queue + notify-on-free* (Jenkins
> Lockable Resources, Redisson Fair Lock) need a server. Local CLIs (`flock`,
> `waitlock`, `run-one`, `py-filelock`) are plain mutexes — no fairness, no
> notify, no human-hold. Agent worktree managers (Claude Squad, Uzi, Conductor)
> isolate *files* and explicitly don't arbitrate shared hardware. mic-lock is
> the combination that didn't exist: **local + serverless + fair FIFO + notify +
> hold-for-approval + agent-friendly.** See [COMPETITORS.md](COMPETITORS.md).

---

## Install

```bash
git clone <this repo> mic-lock && cd mic-lock
npm install
npm run build
npm link          # puts `mic-lock` (and `mlk`) on your PATH
```

Requires Node ≥ 18 (developed on Node 26, macOS). Android discovery uses `adb`;
iOS discovery uses `xcrun simctl` — both optional, the lock core needs neither.

---

## Quick start

```bash
# 0. Find a device id every agent will agree on (adb serial / simulator UDID)
mic-lock discover

# 1. Take it (waits its turn if busy), labelled so `status` is legible
mic-lock acquire emulator-5554 --owner "checkout-flow test" --wait

# 2. Work — install, launch, test — for as long as you hold it
adb -s emulator-5554 install -r app.apk
./gradlew connectedAndroidTest

# 3. See who holds what and who's waiting
mic-lock status

# 4. Give it back
mic-lock release emulator-5554
```

The resource name (`emulator-5554`) is just a stable string every agent agrees
on for that device — use the `adb` serial or simulator UDID from `mic-lock
discover` so everyone converges on the same lock. Unknown names are auto-created
as a simple 1-slot mutex on first use.

### The three ways to hold a device

**1. Hold it for a task of several commands (the usual case):**

```bash
mic-lock acquire emulator-5554 --owner "checkout-flow test" --wait
adb -s emulator-5554 install -r app.apk
# ... launch, poke, run tests — as many commands as you like ...
mic-lock release emulator-5554
```

A manual `acquire` is **sticky** — held until you explicitly `release` it, so it
survives across separate commands, which is exactly what a multi-step device
task needs. When `setup`'s enforcement hook is installed, **holding the lock
also lets your `adb`/`gradlew`/`xcodebuild` commands through** until you release.
Nothing renews a sticky hold, so a crash won't free it automatically — release
promptly, and recover an abandoned hold with `mic-lock status` + `mic-lock
release <device> --force`.

**2. Wrap a single command (crash-safe, auto-releases):**

```bash
mic-lock with emulator-5554 --owner "smoke test" -- \
  bash -c 'adb -s "$MIC_LOCK_DEVICE_ID" install -r app.apk && ./gradlew connectedCheck'
```

Acquires (waiting in line if busy), heartbeats the lease while your command
runs, and releases on exit — even on crash or Ctrl-C. The locked device id is in
`$MIC_LOCK_DEVICE_ID`. Best for one self-contained step; use #1 when you'll issue
separate commands.

**3. Hold until a human approves:**

```bash
mic-lock acquire emulator-5554 --until-approved   # deploy your build, then tell the human:
#   "Ready on emulator-5554 — test it, then run:  mic-lock approve emulator-5554"
```

An `--until-approved` lock never auto-releases and survives your process exiting
(and even a reboot). Only `mic-lock approve emulator-5554` (or `release --force`)
frees it — so a human can manually verify the device before the next agent takes
it.

### Pools and semaphores

If a machine can run *N* interchangeable emulators, register a **pool** and let
agents grab any free one:

```bash
mic-lock config register emulators --kind pool --device-ids emulator-5554 emulator-5556
mic-lock acquire emulators            # grants a specific free device; its id is in the result
```

Or a plain N-slot **semaphore** when the slots are anonymous:

```bash
mic-lock acquire ci-slot --capacity 2 --wait
```

---

## For AI coding agents — install & forget

One command wires everything up so parallel agents coordinate **without you
doing anything per-run**:

```bash
mic-lock setup                # this machine, all projects  (writes ~/.claude/)
mic-lock setup --project      # this repo (committable, travels to teammates)
mic-lock setup --print        # dry run — show what it would change
```

`setup` installs three things (idempotently):

1. **The Claude Code skill** — teaches agents to take a device once and hold it
   for the whole task (`acquire` → work → `release`), wrap one-off commands in
   `mic-lock with …`, label the hold with `--owner`, honor exit codes, and use
   `--until-approved` + `approve` when you want to test by hand.
2. **A PreToolUse hook (`mic-lock guard`)** — *enforcement*. It **blocks** any
   Bash command that touches a shared device (`adb install/shell/push`,
   `emulator` boot, `xcrun simctl`, `gradlew connected*`, `xcodebuild test`,
   `flutter`/`react-native`/`expo run`) **unless the agent's worktree already
   holds a device lock** (so a held session runs freely) or it's wrapped in
   `mic-lock`, and tells the agent how to fix it. Read-only checks (`adb
   devices`, `simctl list`) are allowed. This is deterministic — it does not
   depend on the model choosing to comply.
3. **A `CLAUDE.md` rule** fixing the naming convention (lock by adb serial /
   simulator UDID) so every agent converges on the same lock name.

Scope: **`--user`** (default, `~/.claude/`) covers every project on this
machine; **`--project`** writes the repo's `.claude/` so committing it gives
teammates and other machines the same enforcement (each machine still needs
mic-lock installed from source — see [Install](#install)). Hooks load at session start, so restart agent sessions
after running it.

**Turning it back off** — `mic-lock uninstall` reverses `setup`: it removes
the skill, the `PreToolUse` hook and the `CLAUDE.md` rule (so agents no longer see
*or* enforce it) and purges the lock state at `~/.mic-lock`. It mirrors `setup`'s
scope flags, preserves any unrelated settings/hooks, and is idempotent.

```bash
mic-lock uninstall              # remove from ~/.claude/ + purge locks
mic-lock uninstall --project    # remove this repo's .claude/
mic-lock uninstall --print      # dry run — show what it would remove
mic-lock uninstall --keep-locks # leave ~/.mic-lock intact
```

The purge is skipped (with a warning) if another agent is currently holding or
waiting on a lock — pass `--force` to override. Re-enable anytime with
`mic-lock setup`.

> `uninstall` only undoes `setup` — the `mic-lock` CLI itself stays on your PATH.
> To remove it too, run `npm rm -g mic-lock` (or `npm unlink` in this repo if you
> installed with `npm link`). A symlink you created by hand isn't tracked, so
> delete it yourself.

See [skills/mic-lock/SKILL.md](skills/mic-lock/SKILL.md). All commands support
`--json` for parsing.

---

## Command reference

| Command | What it does |
|---|---|
| `setup [--user\|--project [dir]] [--print]` | Install & forget: skill + enforcement hook + naming rule |
| `uninstall [--user\|--project [dir]] [--print] [--keep-locks] [--force]` | Reverse `setup`: remove skill + hook + rule, purge lock state (leaves the CLI on PATH; aliases: `disable`, `remove`, `teardown`) |
| `guard` | PreToolUse hook (used by `setup`); blocks unwrapped device commands |
| `acquire <res> [--wait] [--timeout <ms>] [--until-approved] [--ttl <s>]` | Take a lock; joins the FIFO queue when busy |
| `release <res> [--token <fence>] [--force] [--reason <t>]` | Release yours, or force-release (steal) someone's |
| `approve <res> [--slot <id>]` | Human releases an `until-approved` hold for the next agent |
| `with <res> -- <cmd…>` | Acquire, run `cmd` with heartbeat, auto-release on exit |
| `status [res] [--watch]` | Holders, wait queues, pending approvals (live with `--watch`) |
| `watch [res] [--events <t,…>]` | Stream lock events as they happen |
| `queue <res>` | The FIFO wait line for one device |
| `discover [--adb] [--simctl]` | List real Android/iOS devices + their lock state |
| `list [--devices]` | List registered resources (and optionally devices) |
| `verify <res> --token <fence>` | Assert your fence still owns the lock (exit 12 if not) |
| `gc [res]` | Reclaim stale locks, prune dead waiters, sweep tombstones |
| `config register\|list\|set-defaults` | Register resources / view / set default tunables |

Global flags (after the subcommand): `--json`, `--state-dir <path>`,
`--no-notify`, `-q/--quiet`, `--verbose`. `--owner <label>` on `acquire`/`with`.

### Exit codes (for scripting/agents)

| code | meaning |
|---|---|
| `0` | success |
| `2` | usage error |
| `10` | busy (no `--wait` given) |
| `11` | timed out waiting |
| `12` | superseded — you lost the lock (stale-broken or force-stolen) |
| `13` | held for human approval |
| `20` | could not take the coordination gate (contention/corruption) |
| `1` | other error |

---

## How it works

mic-lock is a **two-layer lock** over a shared state directory, using classic
algorithms so it's correct without a server.

**Layer 1 — the gate.** A per-resource mutex held for *microseconds*, built on
an atomic create-only primitive (`mkdir`, atomic on APFS). Every state change
runs inside it, so ticket draws, grants and stale-breaks are serialized and
race-free. A gate held longer than a few seconds means a crashed process, so it
is safely broken.

**Layer 2 — the lease.** The holder record carries a monotonic **fence token**,
a lease **TTL**, and a **heartbeat**. This governs who may actually use the
device and how crashes are recovered.

The pieces, and the well-known algorithms behind them:

- **Fairness — Lamport's Bakery algorithm.** Each waiter draws a monotonic
  ticket; the lowest-numbered *live* waiter is served next. A crashed waiter
  ahead of you is skipped, so no one starves. (A gate-free fast path lets only
  the apparent head-of-line take the gate, so N waiters don't all serialize.)
- **Crash recovery — leases.** `with` (and `acquire --ttl`) take a lease that is
  heartbeated in-process; if that process crashes, the lease expires and the
  next waiter reclaims the device. A plain manual `acquire` is instead *sticky*
  (no lease) and is freed only by an explicit `release`/`--force`, so it isn't
  tied to a fragile notion of "the agent's process" — which is why automated
  runs should use `with`. PID liveness uses `kill -0` plus the process start
  time (defeats PID reuse) plus the boot session id (a leased holder from a
  previous boot is treated as dead).
- **Zombie protection — fencing tokens (Kleppmann).** Every grant gets a
  strictly higher fence token. A holder whose lock was stale-broken or stolen
  fails its next renew/release as *superseded* and won't clobber the new holder.
- **Notify-on-free.** Waiters wake via `fs.watch` (FSEvents) with a ~250 ms poll
  backstop for coalesced events, so a freed device is picked up near-instantly.
  Optional macOS desktop notifications + terminal bell announce your turn and
  approval requests.
- **Hold-for-approval.** An `until-approved` lock has no lease expiry and is
  never auto-reclaimed — it survives process death and reboot, and only a human
  `approve` (or `--force`) releases it.

**Safety is structural.** Capacity equals the number of slot files, and a lock
is only ever written into a free slot under the gate — so "≤ capacity holders,
never a double-acquire" does not depend on the bakery being bug-free. This is
exactly what the stress tests assert: 10 contending processes, zero double
acquisitions, capacity always respected, and a SIGKILLed holder reclaimed.

### State layout (`~/.mic-lock/`, override with `--state-dir`)

```
config.json                       # global default tunables
resources/<encoded-name>/
  meta.json                       # kind (mutex|pool|semaphore), capacity, device ids
  gate.lock/                      # Layer-1 coordination mutex (held ~µs)
  seq.json                        # monotonic ticket + fence counters
  holders/<slot>.json             # Layer-2 lease(s): owner, pid, fence, lease, mode
  queue/<ticket>-<owner>.json     # FIFO waiters
  dead/<fence>-<uuid>.json        # retired holders (audit)
  events.ndjson                   # append-only event log (feeds status/watch)
```

### Tuning

Defaults (ms): lease `ttl=12000`, `heartbeat=2000`, `grace=5000`. A healthy
holder renews ~6× per lease, so it must miss several heartbeats before another
agent reclaims it. Override globally or per-resource:

```bash
mic-lock config set-defaults --ttl 20 --heartbeat 3 --grace 8      # seconds
mic-lock config register pixel7 --ttl 30                            # per resource
```

---

## Development

```bash
npm run build         # compile TypeScript to dist/
npm test              # fast, deterministic unit tests (fake clock + fake liveness)
npm run test:stress   # multi-process contention + crash-recovery tests
npm run typecheck
```

The engine is also usable as a library — `import { LockEngine } from "mic-lock"`
— with injectable clock and liveness for testing.

## License

MIT © Michael23Magedy
