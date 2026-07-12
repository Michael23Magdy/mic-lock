/**
 * Best-effort human alerts: a macOS desktop notification when possible, always
 * with a terminal-bell fallback. Never throws and never blocks the caller —
 * these are courtesy pings, not part of the locking protocol.
 */
import { execFile } from "node:child_process";
import { platform } from "node:os";

let disabled = false;

/** Globally disable notifications (wired to --no-notify / MIC_LOCK_NO_NOTIFY). */
export function setNotifyDisabled(value: boolean): void {
  disabled = value;
}

export function notifyEnabled(): boolean {
  return !disabled && process.env.MIC_LOCK_NO_NOTIFY !== "1";
}

/** Ring the terminal bell on stderr. */
export function bell(): void {
  if (!notifyEnabled()) return;
  try {
    process.stderr.write("\x07");
  } catch {
    /* ignore */
  }
}

export interface NotifyOptions {
  title?: string;
  message: string;
}

/** Fire a desktop notification (macOS) and ring the bell. Fire-and-forget. */
export function notify(opts: NotifyOptions): void {
  if (!notifyEnabled()) return;
  bell();
  if (platform() !== "darwin") return;
  const title = (opts.title ?? "mic-lock").replace(/["\\]/g, "");
  const message = opts.message.replace(/["\\]/g, "");
  try {
    execFile(
      "osascript",
      ["-e", `display notification "${message}" with title "${title}"`],
      { timeout: 4000 },
      () => {
        /* ignore success/failure */
      },
    );
  } catch {
    /* ignore */
  }
}
