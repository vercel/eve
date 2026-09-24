import { sleep } from "#compiled/@workflow/core/index.js";
import { describe, expect, it, vi } from "vitest";

import { WaitTimers } from "#tasks/wait-timers.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: vi.fn(),
}));

describe("WaitTimers", () => {
  it("races one durable sleep per timed call and stops racing disarmed calls", async () => {
    const fired = new Map<number, () => void>();
    vi.mocked(sleep).mockImplementation(
      (async (durationMs: number) =>
        await new Promise<void>((resolve) => fired.set(durationMs, resolve))) as typeof sleep,
    );
    const timers = new WaitTimers([
      { callId: "call-w1", timeoutMs: 5_000 },
      { callId: "call-w2", timeoutMs: 9_000 },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);

    const first = timers.next();
    fired.get(9_000)!();
    await expect(first).resolves.toBe("call-w2");

    timers.disarm(["call-w2", "call-w1"]);
    expect(timers.next()).toBeUndefined();

    timers.arm("call-ask", 10_000);
    const grace = timers.next();
    fired.get(10_000)!();
    await expect(grace).resolves.toBe("call-ask");
  });
});
