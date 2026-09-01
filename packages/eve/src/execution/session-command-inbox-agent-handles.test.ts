import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAgentHandleCommandStep } from "#execution/session-command-inbox.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { getAgentHandleStore } from "#harness/handles/store.js";

const write = vi.fn();
const releaseLock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
  getWritable: vi.fn(() => ({ getWriter: () => ({ releaseLock, write }) })),
}));

describe("applyAgentHandleCommandStep", () => {
  beforeEach(() => {
    write.mockReset();
    releaseLock.mockReset();
  });

  it("persists task leases in the canonical session-state handle store", async () => {
    const state = createState();
    const identity = { id: "agent-1", name: "research", nodeId: "subagents/research" };

    const result = await applyAgentHandleCommandStep({
      request: {
        command: {
          identity,
          kind: "reserve",
          operationId: "operation-1",
          taskId: "task-1",
        },
        commandId: "command-1",
        kind: "agent-handle-command",
      },
      sessionState: state,
    });

    const store = getAgentHandleStore(result.sessionState.snapshot?.session.state);
    expect(store).toEqual({
      handles: [
        {
          identity,
          operationId: "operation-1",
          phase: "reserved",
          taskId: "task-1",
        },
      ],
    });
    expect(write).toHaveBeenCalledWith({
      commandId: "command-1",
      result: { handle: store?.handles[0], kind: "ready" },
      store,
    });
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});

function createState(): DurableSessionState {
  return {
    continuationToken: "parent-token",
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
    hasProxyInputRequests: false,
    sessionId: "parent-session",
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent-session",
        state: { existing: true },
      },
      version: 1,
    },
    version: 1,
  };
}
