import { createHash, randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

const TICKET_WIDTH = 12;

/** Zero-pad a ticket so directory listings sort lexically (we still parse numerically). */
export function padTicket(n: number): string {
  return String(n).padStart(TICKET_WIDTH, "0");
}

/**
 * Encode an arbitrary resource name into a filesystem-safe directory name:
 * a readable slug plus a short hash so distinct names never collide even when
 * their slugs match (e.g. "Pixel 7 / API 34" and "pixel-7-api-34").
 */
export function encodeResourceName(name: string): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "res";
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${slug}__${hash}`;
}

/** Parse "000000000042-<uuid>.json" queue filenames into their ticket number. */
export function parseTicketFromQueueFile(filename: string): number | null {
  const m = /^(\d+)-/.exec(filename);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
