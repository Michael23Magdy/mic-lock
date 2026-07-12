/** Assemble the identity of the current agent/process for ownership + status. */
import { execFileSync } from "node:child_process";
import { uuid } from "../util/ids.js";
import type { Liveness } from "./liveness.js";
import type { Identity } from "../types.js";

export interface IdentityOptions {
  label?: string;
  /** Which PID's liveness the lock is tied to. Defaults to the parent (the agent/shell). */
  agentPid?: number;
  cmd?: string;
  cwd?: string;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function buildIdentity(liveness: Liveness, opts: IdentityOptions = {}): Identity {
  const cwd = opts.cwd ?? process.cwd();
  const pid = process.pid;
  const worktree = git(["rev-parse", "--show-toplevel"], cwd);
  const branch = worktree ? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) : undefined;
  const startedAt = liveness.processStartedAt(pid);
  const id: Identity = {
    ownerUuid: uuid(),
    pid,
    agentPid: opts.agentPid ?? process.ppid ?? pid,
    bootId: liveness.bootId(),
  };
  if (opts.label !== undefined) id.label = opts.label;
  if (worktree !== undefined) id.worktree = worktree;
  if (branch !== undefined) id.branch = branch;
  if (startedAt !== undefined) id.startedAt = startedAt;
  if (opts.cmd !== undefined) id.cmd = opts.cmd;
  return id;
}

/** A short, legible owner label for status output. */
export function describeOwner(o: {
  label?: string;
  worktree?: string;
  branch?: string;
  ownerUuid: string;
}): string {
  if (o.label) return o.label;
  if (o.worktree) {
    const base = o.worktree.split("/").pop() ?? o.worktree;
    return o.branch ? `${base}@${o.branch}` : base;
  }
  return o.ownerUuid.slice(0, 8);
}
