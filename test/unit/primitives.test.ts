import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  linkExcl,
  mkdirExcl,
  readJsonOrNull,
  renameIfExists,
  writeAtomic,
} from "../../src/core/fsatomic.js";
import { encodeResourceName, padTicket, parseTicketFromQueueFile } from "../../src/util/ids.js";
import { tempStateDir } from "../helpers.js";

describe("fsatomic", () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempStateDir()));
  afterEach(() => cleanup());

  it("round-trips JSON and returns null for missing/partial", () => {
    const p = join(dir, "a.json");
    expect(readJsonOrNull(p)).toBeNull();
    writeAtomic(p, { x: 1, s: "hi" });
    expect(readJsonOrNull<{ x: number; s: string }>(p)).toEqual({ x: 1, s: "hi" });
  });

  it("mkdirExcl is create-only", () => {
    const d = join(dir, "gate");
    expect(mkdirExcl(d)).toBe(true);
    expect(mkdirExcl(d)).toBe(false);
  });

  it("linkExcl is create-only", () => {
    const src = join(dir, "src");
    writeAtomic(src, { a: 1 });
    const dest = join(dir, "dest");
    expect(linkExcl(src, dest)).toBe(true);
    expect(linkExcl(src, dest)).toBe(false);
  });

  it("renameIfExists reports a missing source instead of throwing", () => {
    expect(renameIfExists(join(dir, "nope"), join(dir, "x"))).toBe(false);
    writeAtomic(join(dir, "y"), 1);
    expect(renameIfExists(join(dir, "y"), join(dir, "z"))).toBe(true);
  });
});

describe("id encoding", () => {
  it("produces filesystem-safe, collision-resistant resource dir names", () => {
    const a = encodeResourceName("Pixel 7 / API 34");
    const b = encodeResourceName("pixel-7-api-34");
    expect(a).toMatch(/^[a-z0-9-]+__[0-9a-f]{8}$/);
    expect(a).not.toBe(b); // different names never collide
    expect(encodeResourceName("Pixel 7 / API 34")).toBe(a); // stable
  });

  it("pads and parses tickets", () => {
    expect(padTicket(42)).toBe("000000000042");
    expect(parseTicketFromQueueFile("000000000042-owner-uuid.json")).toBe(42);
    expect(parseTicketFromQueueFile("not-a-ticket.json")).toBeNull();
  });
});
