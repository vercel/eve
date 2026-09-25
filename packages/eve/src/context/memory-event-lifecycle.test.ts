import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import { dispatchMemoryTurnCompleted } from "#context/memory-lifecycle.js";
import { createTurnCompletedEvent } from "#protocol/message.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

vi.mock("#context/memory-lifecycle.js", () => ({
  dispatchMemoryCompactionCompleted: vi.fn(),
  dispatchMemoryCompactionRequested: vi.fn(),
  dispatchMemoryTurnCompleted: vi.fn(),
  dispatchMemoryTurnStarted: vi.fn(),
}));

describe("dispatchMemoryLifecycleEvent", () => {
  it("captures a held turn once, at its final turn.completed", async () => {
    const dispatch = (held: boolean) =>
      dispatchMemoryLifecycleEvent({
        appRoot: "/app",
        ctx: new ContextContainer() as never,
        event: createTurnCompletedEvent({ held, sequence: 0, turnId: "turn_0" }),
        memories: [{ slot: "notes" } as ResolvedMemoryDefinition],
        messages: [{ content: "Hi", role: "user" }],
        nodeId: "root",
      });

    await dispatch(true);
    expect(dispatchMemoryTurnCompleted).not.toHaveBeenCalled();

    await dispatch(false);
    expect(dispatchMemoryTurnCompleted).toHaveBeenCalledOnce();
  });
});
