import { describe, expect, it } from "vitest";

import { devBootPhase, type DevBootProgressEvent } from "./dev-boot-progress.js";

describe("devBootPhase", () => {
  it("reports one phase to its own observer", async () => {
    const events: DevBootProgressEvent[] = [];

    await expect(
      devBootPhase(
        "compiling agent",
        async () => 42,
        (event) => events.push(event),
      ),
    ).resolves.toBe(42);

    expect(events).toEqual([
      { phase: "compiling agent", type: "phase-started" },
      { elapsedMs: expect.any(Number), phase: "compiling agent", type: "phase-finished" },
    ]);
  });

  it("keeps concurrent observers isolated", async () => {
    const first: DevBootProgressEvent[] = [];
    const second: DevBootProgressEvent[] = [];

    await Promise.all([
      devBootPhase(
        "first",
        async () => undefined,
        (event) => first.push(event),
      ),
      devBootPhase(
        "second",
        async () => undefined,
        (event) => second.push(event),
      ),
    ]);

    expect(first).toEqual([
      { phase: "first", type: "phase-started" },
      { elapsedMs: expect.any(Number), phase: "first", type: "phase-finished" },
    ]);
    expect(second).toEqual([
      { phase: "second", type: "phase-started" },
      { elapsedMs: expect.any(Number), phase: "second", type: "phase-finished" },
    ]);
  });

  it("does not observe an uninstrumented phase", async () => {
    await expect(devBootPhase("orphan", async () => "ok")).resolves.toBe("ok");
  });
});
