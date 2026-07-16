import { describe, expect, test } from "bun:test";
import { runProviderSlot, runScheduler, SLOT_MS, type Clock, type ProviderExecution } from "../src/scheduler";
import type { Provider } from "../src/poll-runner";

describe("scheduler", () => {
  test("uses 288 absolute UTC five-minute slots in 24 hours without drift", async () => {
    let now = new Date("2026-07-16T00:00:17.500Z");
    const slots: string[] = [];
    const controller = new AbortController();
    let sleeps = 0;
    const clock: Clock = {
      now: () => new Date(now),
      sleep: async (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
        if (++sleeps === 288) controller.abort();
        // A real five-minute wait gives the launched provider promise a turn.
        for (let i = 0; i < 4; i++) await Promise.resolve();
      },
    };
    const execute: ProviderExecution = async (request) => { slots.push(request.scheduledFor); };
    await runScheduler({ clock, providers: ["bus"], execute, signal: controller.signal });
    expect(slots).toHaveLength(288);
    expect(slots[0]).toBe("2026-07-16T00:00:00.000Z");
    expect(slots[287]).toBe("2026-07-16T23:55:00.000Z");
    expect(new Date(slots[1]!).getTime() - new Date(slots[0]!).getTime()).toBe(SLOT_MS);
  });

  test("does not catch up or overlap a provider that is still running", async () => {
    let now = new Date("2026-07-16T12:01:00.000Z");
    const controller = new AbortController();
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const clock: Clock = {
      now: () => new Date(now),
      sleep: async (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
        if (now >= new Date("2026-07-16T12:16:00.000Z")) controller.abort();
      },
    };
    const execute: ProviderExecution = async (request) => { calls.push(request.scheduledFor); await first; };
    await runScheduler({ clock, providers: ["srt"], execute, signal: controller.signal });
    expect(calls).toEqual(["2026-07-16T12:00:00.000Z"]);
    release();
  });

  test("a restart runs only its current slot, without a burst of old slots", async () => {
    const starts: string[] = [];
    for (let restart = 0; restart < 2; restart++) {
      const controller = new AbortController();
      const clock: Clock = {
        now: () => new Date("2026-07-16T12:03:00.000Z"),
        sleep: async () => { controller.abort(); await Promise.resolve(); },
      };
      await runScheduler({ clock, providers: ["bus"], signal: controller.signal, execute: async (request) => { starts.push(request.scheduledFor); } });
    }
    expect(starts).toEqual(["2026-07-16T12:00:00.000Z", "2026-07-16T12:00:00.000Z"]);
  });

  test("one provider failure does not block the other providers in its slot", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const clock: Clock = {
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      sleep: async () => { controller.abort(); for (let i = 0; i < 4; i++) await Promise.resolve(); },
    };
    await runScheduler({
      clock,
      providers: ["bus", "srt"],
      signal: controller.signal,
      execute: async (request) => {
        if (request.provider === "bus") throw new Error("bus down");
        ran.push(request.provider);
      },
      timings: { retryDelayMs: 0 },
    });
    expect(ran).toEqual(["srt"]);
  });

  test("times out, closes that lease, then retries the same slot once", async () => {
    const calls: number[] = [];
    const failed: string[] = [];
    const sleeps: number[] = [];
    const execute: ProviderExecution = async (request, signal, onClaim) => {
      calls.push(request.attempt);
      onClaim({ provider: request.provider, runId: request.runId, leaseToken: `lease-${request.attempt}` });
      if (request.attempt === 1) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    await runProviderSlot(
      { provider: "ktx" as Provider, source: "test", scheduledFor: "2026-07-16T12:00:00.000Z" },
      execute,
      async (lease) => { failed.push(lease.leaseToken); },
      async (milliseconds) => { sleeps.push(milliseconds); },
      { providerTimeoutMs: 2, retryDelayMs: 15_000 },
    );
    expect(calls).toEqual([1, 2]);
    expect(failed).toEqual(["lease-1"]);
    expect(sleeps).toEqual([15_000]);
  });
});
