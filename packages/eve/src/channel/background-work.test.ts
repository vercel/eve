import { afterEach, describe, expect, it, vi } from "vitest";

import { createBackgroundWork, WAIT_UNTIL_TIMEOUT_MS } from "#channel/background-work.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("channel background work", () => {
  it("waits for queued work and the work it queues", async () => {
    const background = createBackgroundWork({ adapterKind: "chat" });
    const seen: string[] = [];
    const waitUntil = background.waitUntilFor("model.started");
    waitUntil(
      (async () => {
        await Promise.resolve();
        seen.push("first");
        waitUntil(
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            seen.push("second");
          })(),
        );
      })(),
    );

    expect(await background.settle()).toBe(true);
    expect(seen).toEqual(["first", "second"]);
    expect(await background.settle()).toBe(false);
  });

  it("logs a rejection instead of throwing it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const background = createBackgroundWork({ adapterKind: "chat" });
    background.waitUntilFor("turn.started")(Promise.reject(new Error("Rate limited.")));

    await expect(background.settle()).resolves.toBe(true);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("a channel event handler's waitUntil work failed"),
      expect.objectContaining({ adapterKind: "chat", eventType: "turn.started" }),
    );
  });

  it("stops waiting for work that never settles, and names it", async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const background = createBackgroundWork({ adapterKind: "chat" });
    background.waitUntilFor("model.started")(Promise.resolve());
    background.waitUntilFor("turn.started")(new Promise(() => {}));

    const settled = background.settle();
    await vi.advanceTimersByTimeAsync(WAIT_UNTIL_TIMEOUT_MS);

    await expect(settled).resolves.toBe(true);
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("waitUntil work didn't settle in time"),
      expect.objectContaining({
        adapterKind: "chat",
        eventTypes: ["turn.started"],
        timeoutMs: WAIT_UNTIL_TIMEOUT_MS,
      }),
    );
    // What was left behind isn't waited for again.
    expect(await background.settle()).toBe(false);
  });

  it("warns about work queued after the step ended, and doesn't wait for it", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const background = createBackgroundWork({ adapterKind: "chat" });
    background.close();
    background.waitUntilFor("model.started")(new Promise(() => {}));

    expect(await background.settle()).toBe(false);
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("called waitUntil after its step ended"),
      expect.objectContaining({ adapterKind: "chat", eventType: "model.started" }),
    );
  });
});
