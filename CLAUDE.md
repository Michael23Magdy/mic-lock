# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mic-lock` (CLI: `mic-lock`, alias `mlk`) is a **local, serverless lock for shared test devices** (Android emulators, iOS simulators, phones) so multiple AI coding agents working in different git worktrees on one machine don't clobber each other's device installs/test state. It gives each device a **fair FIFO lock with notify-on-free and optional hold-for-human-approval**. No server, no daemon, no Redis — all coordination is atomic filesystem operations under `~/.mic-lock/`. Published to npm as `mic-lock`; also usable as a library (`import { LockEngine } from "mic-lock"`).

## Commands

```bash
npm run build         # tsc -> dist/ (also chmod +x the bin). Emits .d.ts (declaration:true).
npm test              # vitest run test/unit  — fast, deterministic (fake clock + fake liveness), no build needed
npm run test:stress   # build THEN vitest run test/stress — real multi-process contention + crash recovery
npm run test:all      # build THEN all tests
npm run typecheck     # tsc --noEmit
npm run start         # node dist/bin/mic-lock.js  (run the built CLI)

# Run a single test file / one test:
npx vitest run test/unit/engine.test.ts
npx vitest run test/unit/engine.test.ts -t "reclaims a leased holder"
```

Unit tests import the `.ts` sources directly (no build) — `vitest.config.ts` has a `jsToTs` resolver plugin that maps NodeNext `.js` import specifiers to `.ts`. **Stress tests run the compiled `dist/`, so they build first.** Node ≥ 18, ESM throughout (`"type": "module"`).

## Architecture — the two-layer lock (the part that needs multiple files)

Everything correctness-related lives in `src/core/`. The engine is a pure library (`src/core/lock.ts`, `LockEngine`) that **never** calls `process.exit` or prints; the `src/commands/*.ts` layer wraps it for the CLI. `src/index.ts` is the library entry point.

**Layer 1 — the gate** (`src/core/gate.ts`): a per-resource mutex held for microseconds, built on `mkdirExcl` (create-only, atomic on APFS). `withGate(ctx, paths, tun, fn)` runs every state mutation inside it so ticket draws, grants, and stale-breaks are serialized and race-free. **`fn` passed to `withGate` MUST be synchronous** — atomicity against other in-process async tasks depends on it (other processes are excluded by the gate itself). Never `await` inside a gated section. A gate held longer than `gateStaleMs` is treated as a crashed process and broken.

**Layer 2 — the lease** (`src/core/holder.ts`, `src/core/staleness.ts`): the holder record carries a monotonic **fence token**, a lease **TTL**, and a **heartbeat**, governing who may use the device and how crashes recover.

Acquire flow in `lock.ts` is **enter → poll* → grant | leave**:
- `enter()` draws a FIFO ticket and enqueues a waiter.
- `poll()` has a **gate-free fast path**: it reads meta/holders/queue without the gate, and only an apparent head-of-line waiter with a free slot bothers to take the gate. Under the gate it re-checks everything and grants only if `rank < capacity && free slot exists` — so the fast path is a pure filter and can never over-grant.
- `grantUnderGate()` draws a fence and writes the holder into a free slot.

### The single most important behavioral distinction: sticky vs leased holds
- **Sticky** — a plain `mic-lock acquire` with no `--ttl` sets `leaseExpiresAt = null`. It is **never** auto-reclaimed; a crash does NOT free it. Recover an abandoned sticky hold with `release --force`. This is intentional so a multi-command device task survives across separate shell invocations.
- **Leased** — `with` and `acquire --ttl` heartbeat the lease in-process; if the process dies, the lease expires (`ttl + grace`) and the next waiter reclaims. **Automated runs should use `with`.**
- **until-approved** — sticky forever, survives process death and reboot; only a human `approve` (or `release --force`) frees it.

### Why safety doesn't depend on the fairness algorithm being bug-free
Capacity = the number of slot files (`src/core/slots.ts`); a grant only ever writes into a free slot **under the gate**. So "≤ capacity holders, never a double-acquire" holds regardless of bakery correctness — the bakery (`src/core/bakery.ts`, Lamport's Bakery) only governs *fairness/order*. The stress tests assert this structurally.

Supporting pieces: `seq.ts` (monotonic ticket + fence counters, no CAS needed since the caller holds the gate), `liveness.ts` (PID liveness via `kill -0` + process start time to defeat PID reuse + boot-session id so a previous-boot holder is dead), `fsatomic.ts` (write-temp-then-rename; **deliberately no fsync** — state is ephemeral; torn reads are tolerated by `readJsonOrNull` returning null), `paths.ts` (state-dir layout), `eventlog.ts` (append-only `events.ndjson` feeding status/watch), `identity.ts`, `tunables.ts`.

### Notify-on-free
`src/events/watcher.ts` (`ResourceWatcher`): `fs.watch` (FSEvents) is the low-latency signal with a ~250ms poll backstop for coalesced/dropped events — every event just means "re-evaluate," never carries data. `src/events/notify.ts` is best-effort macOS desktop notifications + terminal bell (never throws/blocks; gated by `--no-notify` / `MIC_LOCK_NO_NOTIFY`).

## The agent-enforcement mechanism (setup / guard)

`mic-lock setup` (`src/commands/setup.ts`) idempotently installs three things into `~/.claude/` (`--user`, default, machine-wide) or `<repo>/.claude/` (`--project`, committable): (1) the Claude Code **skill** (`skills/mic-lock/SKILL.md`), (2) a **PreToolUse hook** `mic-lock guard`, (3) a **CLAUDE.md naming rule**. `src/core/enforcement.ts` holds the shared constants (hook command, rule marker/body) so setup and uninstall never drift; `uninstall.ts` reverses it and can purge `~/.mic-lock`.

`mic-lock guard` (`src/commands/guard.ts` + pure `src/core/guard.ts` `evaluateGuard`) is the enforcement: it **blocks** a Bash command that drives a shared device (`adb install/shell/push`, `emulator` boot, `xcrun simctl`, `gradlew connected*`/`install*`, `xcodebuild test`, `flutter`/`react-native`/`expo`/`maestro` run) **unless** it's wrapped in a real `mic-lock`/`mlk` invocation OR the current git worktree already holds a lock (`currentWorktreeHoldsLock`). Read-only probes (`adb devices`, `simctl list`) are allowed. **Both enforcement decisions fail safe toward blocking** on error.

`MIC_LOCK_ENFORCE=scoped` (also `marker`/`project`) downgrades a would-be block to allow **unless** the project opted in via `setup --project` (detected by `projectHasMicLockMarker`). This lets the guard be installed machine-wide but only enforce in participating repos.

## Devices & discovery

`src/devices/registry.ts` aggregates `adb.ts` (Android) + `simctl.ts` (iOS). The correctness-critical, unit-tested pure function is `buildAndroidDevices()` in `src/devices/adb.ts`: it correlates running `emulator-XXXX` serials to their AVD names and dedups against `emulator -list-avds`, so **a booted emulator never also shows up as a phantom not-booted row** (prevents agents rebooting a live device). Lock resource names should be the adb serial / simulator UDID from `discover` so every agent converges on the same lock string.

## Conventions & gotchas

- **Exit codes are the agent contract** (`src/util/exitcodes.ts`): 0 ok, 2 usage, 10 busy, 11 timeout, 12 superseded (you lost the lock — fence mismatch), 13 held-for-approval, 20 gate timeout, 1 other. Branch on these, not on text. `__hammer` uses 33 for a detected double-acquire.
- **Fencing tokens (Kleppmann)** defeat zombies: after a stale-break/steal, the old holder's next `renewHolder`/`release --token` fails as SUPERSEDED and can't clobber the new holder; `with` reacts by SIGTERMing its child.
- **Version is duplicated**: `VERSION` in `src/cli.ts` and `version` in `package.json` — update both on release.
- **`--json` on every command** for machine parsing; `--state-dir` overrides `~/.mic-lock` (also `$MIC_LOCK_STATE_DIR`). `--owner` is per-command (`acquire`/`with`), falls back to `$MIC_LOCK_OWNER` then the git worktree.
- Tests inject `new LockEngine({ stateDir, clock: new FakeClock(...), liveness })` (see `test/helpers.ts` `FakeLiveness`) to drive the engine with no real time/processes/races. Follow that pattern for new engine tests; verify concurrency claims in `test/stress/concurrency.test.ts`.
- Minor known dead code (don't be misled): `paths.versionFile`/`bootFile` + `SCHEMA_VERSION`, `eventlog.hasEvents`, `holder.removeHolder`, the `readHolder` import in `lock.ts`, and `EventType`'s `"renewed"` (never emitted).

## Design rationale

See `README.md` (full user-facing docs + command reference + state layout) and `COMPETITORS.md` (why local + serverless + fair-FIFO + notify + hold-for-approval didn't exist before).
