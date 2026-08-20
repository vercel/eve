import { describe, expect, it, vi } from "vitest";

import { readLocalSubagentWork } from "#execution/local-subagent-work-query.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";

const getRunMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
}));

describe("readLocalSubagentWork", () => {
  it("reads the latest dedicated work snapshot for a direct local child", async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const getReadable = vi.fn(() => ({
      getReader: () => ({
        cancel,
        read: async () => ({ done: false, value: { revision: 3 } }),
        releaseLock,
      }),
    }));
    getRunMock.mockReturnValue({ getReadable });

    await expect(
      readLocalSubagentWork({
        callId: "call-1",
        parentState: {
          [AGENT_HANDLES_STATE_KEY]: {
            handles: [
              {
                address: {
                  continuationToken: "subagent:child",
                  kind: "agent/local",
                  sessionId: "child-session",
                },
                identity: { id: "ag_research", name: "researcher", nodeId: "subagents/researcher" },
                operation: { callId: "call-1", id: "op-1", kind: "start", parentTurnId: "turn-1" },
                phase: "running",
              },
            ],
          },
        },
      }),
    ).resolves.toEqual({ kind: "available", revision: 3, work: { revision: 3 } });

    expect(getReadable).toHaveBeenCalledWith({ namespace: "eve.work", startIndex: -1 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("does not query remote or missing children", async () => {
    getRunMock.mockClear();
    await expect(readLocalSubagentWork({ callId: "missing", parentState: {} })).resolves.toEqual({
      kind: "unavailable",
      reason: "not-running",
    });
    expect(getRunMock).not.toHaveBeenCalled();
  });
});
