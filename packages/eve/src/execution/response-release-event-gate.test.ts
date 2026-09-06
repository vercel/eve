import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ResponseReleaseEventGate } from "#execution/response-release-event-gate.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";

const { dispatchBeforeResponseReleaseHooks } = vi.hoisted(() => ({
  dispatchBeforeResponseReleaseHooks: vi.fn(),
}));

vi.mock("#context/hook-lifecycle.js", () => ({ dispatchBeforeResponseReleaseHooks }));

const terminal = {
  data: {
    finishReason: "stop" as const,
    message: "candidate",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  },
  type: "message.completed" as const,
};

const registry: RuntimeHookRegistry = {
  beforeResponseRelease: [{ handler: vi.fn(), slug: "review" }],
  streamEventsByType: new Map(),
  streamEventsWildcard: [],
};

describe("ResponseReleaseEventGate", () => {
  it("withholds then releases a terminal completion when history is retained", async () => {
    const gate = new ResponseReleaseEventGate(new ContextContainer(), registry);
    const release = vi.fn().mockResolvedValue(undefined);

    expect(gate.intercept(terminal)).toBe(true);
    await expect(
      gate.beforeRelease(release)!({ history: [], output: "candidate", turnId: "turn_0" }),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledWith(terminal);
  });

  it("does not intercept task-mode terminal completions", () => {
    const gate = new ResponseReleaseEventGate(new ContextContainer(), registry, false);

    expect(gate.intercept(terminal)).toBe(false);
    expect(gate.beforeRelease(vi.fn())).toBeUndefined();
  });

  it("does not intercept a response that parks on tool calls", () => {
    const gate = new ResponseReleaseEventGate(new ContextContainer(), registry);

    expect(
      gate.intercept({
        ...terminal,
        data: { ...terminal.data, finishReason: "tool-calls" },
      }),
    ).toBe(false);
  });

  it("drops a terminal completion when a hook requests history restoration", async () => {
    dispatchBeforeResponseReleaseHooks.mockImplementationOnce(async ({ candidate }) => {
      candidate.history.restoreTo(1);
    });
    const gate = new ResponseReleaseEventGate(new ContextContainer(), registry);
    const release = vi.fn().mockResolvedValue(undefined);

    expect(gate.intercept(terminal)).toBe(true);
    await expect(
      gate.beforeRelease(release)!({
        history: [
          { content: "keep", role: "user" },
          { content: "remove", role: "assistant" },
        ],
        output: "candidate",
        turnId: "turn_0",
      }),
    ).resolves.toBe(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("uses the earliest restoration requested by several hooks", async () => {
    dispatchBeforeResponseReleaseHooks.mockImplementationOnce(async ({ candidate }) => {
      candidate.history.restoreTo(2);
      candidate.history.restoreTo(1);
    });
    const gate = new ResponseReleaseEventGate(new ContextContainer(), registry);

    await expect(
      gate.beforeRelease(vi.fn())!({
        history: [
          { content: "keep", role: "user" },
          { content: "remove", role: "assistant" },
          { content: "remove too", role: "user" },
        ],
        output: "candidate",
        turnId: "turn_0",
      }),
    ).resolves.toBe(1);
  });
});
