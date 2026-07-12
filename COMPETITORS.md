# Competitors & prior art

Research done before building mic-lock, to check the niche was real. **Short
version:** no existing tool combines all six of mic-lock's properties — most
have two or three. The tools with a *fair FIFO queue + notify-on-free* all need
a server; the *local, serverless CLIs* are plain mutexes with no fairness, no
notify, and no human-hold; the *agent worktree managers* isolate files and
explicitly don't arbitrate shared hardware.

## Feature matrix

| | local, no server | mutual exclusion | fair FIFO queue | notify on free | hold for human approval | headless agent CLI |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **mic-lock** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| DeviceFarmer/STF, AWS Device Farm, BrowserStack, Firebase Test Lab | ❌ | ✅ | mostly ❌ | server-side only | interactive sessions only | ❌ |
| Jenkins Lockable Resources | ❌ | ✅ | ✅ | ❌ | ✅ (reserve) | ❌ |
| GitLab `resource_group` / GitHub Actions `concurrency` | ❌ | ✅ | GitLab ✅ / GHA ❌ | ❌ | manual gate only | ❌ |
| `flock`, `setlock`, `run-one`, `waitlock` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| `proper-lockfile`, `py-filelock` | ✅ | ✅ | ❌ | ❌ | ❌ | library |
| Redisson Fair Lock / Redlock | ❌ (Redis) | ✅ | ✅ | ✅ (pub/sub) | ❌ | library |
| Claude Squad / Uzi / Conductor / Vibe Kanban | ✅ | files only | ❌ | ❌ | ❌ | partial |
| `agent-orchestration` MCP | ✅ | ✅ | ❌ | ❌ | ❌ | MCP |

## By category

### Mobile device farms / reservation systems
- **DeviceFarmer / STF** (open source, needs Node + RethinkDB + ZeroMQ): browser
  control of Android devices; clicking "Use" takes an exclusive lock held
  indefinitely (an interactive human-hold), plus a booking/reservation REST API.
  Server-based; no fair FIFO wait queue or notify for headless clients.
- **AWS Device Farm / BrowserStack / Sauce Labs / Firebase Test Lab** (cloud):
  concurrency via purchased slots or project quotas; the "human tests it" analog
  exists only as interactive live/remote sessions, never as a queued,
  agent-acquirable lock. Cloud only.
- **Genymotion Cloud**: quota-limited cloud emulators. No fair queue / notify /
  hold.

### CI resource locking
- **Jenkins Lockable Resources**: the closest feature match — FIFO by default,
  and reserve-a-resource-indefinitely-for-a-human. But it requires a Jenkins
  server and binds to Jenkins builds, not arbitrary local processes.
- **GitLab `resource_group`** (`oldest_first` = FIFO) and **GitHub Actions
  `concurrency`** (default: newest-pending wins, *not* fair): server/CI only, no
  notify, human-hold only via manual gates.
- **`flock`(util-linux), `setlock`(daemontools), `run-one`, `waitlock`**: local
  CLI mutexes (some with a semaphore mode) that auto-release on process death —
  but no fairness ordering, no notify, no human-hold. (macOS ships no `flock`.)

### Generic lock libraries
- **`proper-lockfile`, `lockfile`, `py-filelock`**: robust local/inter-process
  locks (atomic `mkdir` / `fcntl`, mtime staleness). Libraries, polling, no FIFO
  fairness, no notify.
- **Redisson Fair Lock / Redlock**: true FIFO across clients + Redis pub/sub to
  wake the next waiter + counting semaphores + fencing tokens — the design
  mic-lock mirrors, but it needs a Redis server and is a JVM library, not a CLI.

### Android/iOS specific
- **Gradle Managed Devices**: within-build emulator parallelism, not a
  cross-process reservation.
- **Appium Device Farm plugin**: dynamic device pool with block/unblock, but
  needs an Appium hub. **AOSP Trade Federation `DeviceManager`**: powerful
  allocator embedded in a big harness. `simctl` has no locking (the iOS pattern
  is clone-a-sim-per-job).

### AI-agent coordination (2024–2026)
- **Claude Squad, Uzi, Conductor, Vibe Kanban, container-use, Agent Teams**: the
  category converged on git worktrees (+ tmux/containers) to isolate each
  agent's *files/edits*; some assign a unique dev port. None arbitrate a shared
  external device — it's out of scope for them.
- **`agent-orchestration` MCP**: the closest agent-oriented lock (SQLite-backed
  `lock_acquire`/`release`/`check`), but plain mutual exclusion — no documented
  FIFO fairness, notify, or human-approval hold.

## Ideas borrowed
- Fencing tokens (Redisson/Kleppmann) → a monotonic token per grant so a
  resurrected zombie can't clobber the new holder.
- mtime/PID staleness (proper-lockfile/py-filelock) + auto-release-on-death
  (flock) → crash recovery in a serverless design.
- Jenkins's indefinite manual "reserve" and steal/unlock actions → the
  `--until-approved` hold and `--force` steal.
- STF's event stream and Redisson's pub/sub → notify-on-free via `fs.watch`.
- GNU `sem` / task-spooler's N-slot model → the counting-semaphore / pool kind.

## Sources
DeviceFarmer/STF · Jenkins Lockable Resources plugin · GitHub Actions
concurrency · GitLab `resource_group` · `flock(1)` / `setlock` / `run-one` /
`waitlock` · `proper-lockfile` / `py-filelock` · Redisson locks & fair lock ·
Kleppmann, "How to do distributed locking" · Gradle Managed Devices · Appium
Device Farm · AWS Device Farm slots · Firebase Test Lab quotas · BrowserStack
App Live · `agent-orchestration` MCP · Claude Squad / Uzi / Conductor / Vibe
Kanban.
