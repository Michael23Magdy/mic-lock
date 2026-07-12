/**
 * Low-latency wake source: fs.watch (FSEvents on macOS) coalesced with a poll
 * backstop. Every filesystem event is treated as "re-evaluate", never as data —
 * FSEvents coalesces and can drop events, so the periodic poll guarantees
 * correctness while the watch guarantees speed.
 */
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { ensureDir } from "../core/fsatomic.js";

export interface WatcherOptions {
  /** Correctness backstop interval (ms). */
  pollMs?: number;
  /** Coalesce bursts of events within this window (ms). */
  debounceMs?: number;
}

export class ResourceWatcher {
  private watcher: FSWatcher | undefined;
  private pendingWaiters: Array<() => void> = [];
  private subscribers = new Set<() => void>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly root: string;

  constructor(root: string, opts: WatcherOptions = {}) {
    this.root = root;
    // fs.watch is the primary, low-latency signal; the poll is a correctness
    // backstop for coalesced/dropped FSEvents. 250ms bounds worst-case handoff
    // without meaningfully loading the (sub-millisecond) gate.
    this.pollMs = opts.pollMs ?? 250;
    this.debounceMs = opts.debounceMs ?? 30;
    ensureDir(root);
    this.arm();
  }

  private arm(): void {
    if (this.closed) return;
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, () =>
        this.scheduleFire(),
      );
      this.watcher.on("error", () => this.rearmSoon());
    } catch {
      // Recursive watch unsupported or dir churned; poll-only until re-armed.
      this.watcher = undefined;
    }
  }

  private rearmSoon(): void {
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = undefined;
    if (!this.closed) setTimeout(() => this.arm(), 250).unref?.();
  }

  private scheduleFire(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.fire();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private fire(): void {
    const waiters = this.pendingWaiters;
    this.pendingWaiters = [];
    for (const w of waiters) w();
    for (const s of this.subscribers) s();
  }

  /** Resolve on the next change or after the poll interval, whichever comes first. */
  wait(maxMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    const cap = Math.min(Math.max(maxMs, 0), this.pollMs);
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      // NOT unref'd: while a caller is actively waiting for a lock, this timer
      // is what keeps the process alive (fs.watch is non-persistent).
      const timer = setTimeout(finish, cap);
      this.pendingWaiters.push(finish);
    });
  }

  /** Subscribe to change events (for `watch` / `status --watch`). Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.fire(); // release any parked waiters
  }
}
