import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockEngine } from "../../src/core/lock.js";
import { FakeClock } from "../../src/util/time.js";
import { readEvents } from "../../src/core/eventlog.js";
import { resourcePaths } from "../../src/core/paths.js";
import { DEFAULT_TUNABLES } from "../../src/core/tunables.js";
import { FakeLiveness, ident, tempStateDir } from "../helpers.js";

describe("LockEngine", () => {
  let dir: string;
  let cleanup: () => void;
  let clock: FakeClock;
  let liveness: FakeLiveness;
  let engine: LockEngine;

  beforeEach(() => {
    ({ dir, cleanup } = tempStateDir());
    clock = new FakeClock(1_000);
    liveness = new FakeLiveness();
    engine = new LockEngine({ stateDir: dir, clock, liveness });
  });
  afterEach(() => cleanup());

  it("grants a free mutex and blocks a second acquirer until release", async () => {
    const a = ident(liveness);
    const b = ident(liveness);

    const wa = await engine.enter("dev", { identity: a });
    const ra = await engine.poll(wa);
    expect(ra?.fenceToken).toBe(1);
    expect(ra?.slotId).toBe("0");
    expect(ra?.deviceId).toBe("dev");

    const wb = await engine.enter("dev", { identity: b });
    expect(await engine.poll(wb)).toBeNull();

    await engine.release("dev", { token: ra!.fenceToken });
    const rb = await engine.poll(wb);
    expect(rb).toBeTruthy();
    expect(rb!.fenceToken).toBeGreaterThan(ra!.fenceToken);
  });

  it("serves waiters in FIFO ticket order regardless of poll order (bakery)", async () => {
    const a = ident(liveness);
    const b = ident(liveness);
    const c = ident(liveness);
    const wa = await engine.enter("dev", { identity: a }); // ticket 1
    const wb = await engine.enter("dev", { identity: b }); // ticket 2
    const wc = await engine.enter("dev", { identity: c }); // ticket 3

    // C and B poll first but must not jump ahead of A.
    expect(await engine.poll(wc)).toBeNull();
    expect(await engine.poll(wb)).toBeNull();
    const ra = await engine.poll(wa);
    expect(ra).toBeTruthy();

    await engine.release("dev", { token: ra!.fenceToken });
    // Now B is head; C still must wait.
    expect(await engine.poll(wc)).toBeNull();
    expect(await engine.poll(wb)).toBeTruthy();
  });

  it("skips a crashed waiter ahead in line (no starvation)", async () => {
    const a = ident(liveness);
    const b = ident(liveness);
    await engine.enter("dev", { identity: a }); // ticket 1
    const wb = await engine.enter("dev", { identity: b }); // ticket 2

    liveness.kill(a.pid); // A crashes while queued
    const rb = await engine.poll(wb);
    expect(rb).toBeTruthy(); // B is served despite a lower-ticket dead waiter
  });

  it("reclaims a crashed leased holder after lease expiry and bumps the fence", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a, ttlMs: DEFAULT_TUNABLES.ttlMs });
    const ra = await engine.poll(wa);
    expect(ra!.fenceToken).toBe(1);

    liveness.kill(a.pid); // holder crashes without releasing
    clock.advance(DEFAULT_TUNABLES.ttlMs + DEFAULT_TUNABLES.graceMs + 1);

    const b = ident(liveness);
    const wb = await engine.enter("dev", { identity: b });
    const rb = await engine.poll(wb);
    expect(rb).toBeTruthy();
    expect(rb!.fenceToken).toBeGreaterThan(ra!.fenceToken);

    const events = readEvents(resourcePaths(dir, "dev")).map((e) => e.type);
    expect(events).toContain("stale-broken");
  });

  it("never auto-reclaims a sticky (un-ttl'd) manual hold", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a }); // no ttl => sticky
    const ra = await engine.poll(wa);
    expect(ra).toBeTruthy();

    liveness.kill(a.pid); // the acquiring process exits, as manual holds do
    clock.advance(1_000_000);

    const b = ident(liveness);
    const wb = await engine.enter("dev", { identity: b });
    expect(await engine.poll(wb)).toBeNull(); // still held; only explicit release frees it

    await engine.release("dev", { token: ra!.fenceToken });
    expect(await engine.poll(wb)).toBeTruthy();
  });

  it("never reclaims an until-approved hold; only approve releases it", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a, mode: "until-approved" });
    const ra = await engine.poll(wa);
    expect(ra!.mode).toBe("until-approved");

    liveness.kill(a.pid); // agent dies
    clock.advance(1_000_000); // long past any lease

    const b = ident(liveness);
    const wb = await engine.enter("dev", { identity: b });
    expect(await engine.poll(wb)).toBeNull();
    expect(wb.blockedByApproval).toBe(true);

    await engine.approve("dev", { by: "tester" });
    expect(await engine.poll(wb)).toBeTruthy();

    const events = readEvents(resourcePaths(dir, "dev")).map((e) => e.type);
    expect(events).toContain("approval-requested");
    expect(events).toContain("approved");
  });

  it("enforces capacity for a semaphore and frees a slot on release", async () => {
    const a = ident(liveness);
    const b = ident(liveness);
    const c = ident(liveness);

    const wa = await engine.enter("pool", { identity: a, capacity: 2 });
    const ra = await engine.poll(wa);
    const wb = await engine.enter("pool", { identity: b });
    const rb = await engine.poll(wb);
    expect(ra).toBeTruthy();
    expect(rb).toBeTruthy();
    expect(ra!.slotId).not.toBe(rb!.slotId);

    const wc = await engine.enter("pool", { identity: c });
    expect(await engine.poll(wc)).toBeNull(); // full

    await engine.release("pool", { token: ra!.fenceToken });
    expect(await engine.poll(wc)).toBeTruthy();
  });

  it("grants distinct device ids from a pool", async () => {
    const a = ident(liveness);
    const b = ident(liveness);
    const wa = await engine.enter("emus", { identity: a, deviceIds: ["emu-a", "emu-b"] });
    const ra = await engine.poll(wa);
    const wb = await engine.enter("emus", { identity: b });
    const rb = await engine.poll(wb);
    expect([ra!.deviceId, rb!.deviceId].sort()).toEqual(["emu-a", "emu-b"]);
    expect(ra!.slotId).toBe(ra!.deviceId);
  });

  it("fences out a holder after a forced steal", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a });
    const ra = await engine.poll(wa);

    await engine.release("dev", { force: true, reason: "manual override" });
    const b = ident(liveness);
    const wb = await engine.enter("dev", { identity: b });
    const rb = await engine.poll(wb);
    expect(rb!.fenceToken).toBeGreaterThan(ra!.fenceToken);

    // The original holder's renew must now fail as superseded.
    const renew = await engine.renewHolder("dev", a.ownerUuid, ra!.fenceToken);
    expect(renew.superseded).toBe(true);
  });

  it("release --token rejects a stale token as superseded", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a });
    const ra = await engine.poll(wa);
    // Someone else now holds it (simulate by force + reacquire).
    await engine.release("dev", { force: true });
    const b = ident(liveness);
    const wb = await engine.enter("dev", { identity: b });
    await engine.poll(wb);

    await expect(engine.release("dev", { token: ra!.fenceToken })).rejects.toThrow(/superseded/i);
  });

  it("verifyFence reports current vs superseded", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a });
    const ra = await engine.poll(wa);
    expect(engine.verifyFence("dev", ra!.fenceToken).current).toBe(true);
    expect(engine.verifyFence("dev", 999).current).toBe(false);
  });

  it("treats leased holders from a previous boot as dead", async () => {
    const a = ident(liveness);
    const wa = await engine.enter("dev", { identity: a, ttlMs: DEFAULT_TUNABLES.ttlMs });
    const ra = await engine.poll(wa);
    expect(ra).toBeTruthy();

    liveness.reboot("boot-2"); // machine rebooted; old PID meaningless
    const b = ident(liveness); // b.bootId is now boot-2
    const wb = await engine.enter("dev", { identity: b });
    const rb = await engine.poll(wb);
    expect(rb).toBeTruthy(); // reclaimed the prior-boot holder
  });
});
