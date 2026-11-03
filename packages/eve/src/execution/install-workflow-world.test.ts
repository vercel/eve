import { describe, expect, it, vi } from "vitest";

import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";

describe("closeWorkflowWorld", () => {
  it("closes the installed World once, so its timers cannot keep a stopped server alive", async () => {
    const close = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    await installWorkflowWorld({
      world: { close, createQueueHandler: () => undefined, events: {}, specVersion: 9, start },
    } as never);

    await closeWorkflowWorld();
    await closeWorkflowWorld();

    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("logs a failed close instead of rejecting, so later Nitro close hooks still run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await installWorkflowWorld({
      world: {
        close: async () => {
          throw new Error("pool already ended");
        },
        createQueueHandler: () => undefined,
        events: {},
        specVersion: 9,
      },
    } as never);

    await expect(closeWorkflowWorld()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("pool already ended"));
    error.mockRestore();
  });

  it("does nothing before a World is installed", async () => {
    await expect(closeWorkflowWorld()).resolves.toBeUndefined();
  });
});
