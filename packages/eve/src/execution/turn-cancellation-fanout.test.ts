import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelRemoteAgentTurn } from "#execution/remote-agent-dispatch.js";
import {
  cancelTurnWithDescendantFanout,
  collectPendingDescendants,
} from "#execution/turn-cancellation-fanout.js";
import { requestWorkflowTurnCancellation } from "#execution/turn-cancellation-request.js";
import { getRun } from "#internal/workflow/runtime.js";

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: vi.fn(),
}));

vi.mock("./turn-cancellation-request.js", () => ({
  requestWorkflowTurnCancellation: vi.fn(),
}));

vi.mock("./remote-agent-dispatch.js", () => ({
  cancelRemoteAgentTurn: vi.fn(),
  isRetryableRemoteAgentCancelError: vi.fn(() => false),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function subagentCalled(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly remote?: { readonly url: string };
  readonly turnId?: string;
}) {
  return {
    data: {
      callId: input.callId,
      childSessionId: input.childSessionId,
      name: "child",
      remote: input.remote,
      sequence: 0,
      sessionId: "parent",
      toolName: "child",
      turnId: input.turnId ?? "turn_0",
      workflowId: "workflow//eve//workflowEntry",
    },
    type: "subagent.called",
  };
}

function actionResult(callId: string) {
  return {
    data: {
      result: { callId, kind: "subagent-result", output: "done", subagentName: "child" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_0",
    },
    type: "action.result",
  };
}

/**
 * Mimics a live run stream: journaled chunks are followed by an open tail
 * that never closes, exactly like a parked durable session's event stream.
 */
function installEventStreams(streamsBySessionId: Record<string, unknown[]>): void {
  vi.mocked(getRun).mockImplementation(
    (sessionId: string) =>
      ({
        getReadable: () => {
          const events = streamsBySessionId[sessionId] ?? [];
          const chunks = events.map((event) =>
            new TextEncoder().encode(`${JSON.stringify(event)}\n`),
          );
          let index = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks[index];
              if (chunk !== undefined) {
                controller.enqueue(chunk);
                index += 1;
              }
              // Past the tail the stream stays open, like a live run.
            },
          }) as ReadableStream<Uint8Array> & { getTailIndex: () => Promise<number> };
          stream.getTailIndex = async () => chunks.length - 1;
          return stream;
        },
      }) as never,
  );
}

describe("collectPendingDescendants", () => {
  it("returns dispatched children without results and skips resolved ones", () => {
    const records = collectPendingDescendants({
      events: [
        subagentCalled({ callId: "call-1", childSessionId: "child-1" }),
        subagentCalled({ callId: "call-2", childSessionId: "child-2" }),
        actionResult("call-1"),
      ],
    });

    expect(records).toEqual([
      expect.objectContaining({ callId: "call-2", childSessionId: "child-2" }),
    ]);
  });

  it("filters by turn id when provided", () => {
    const records = collectPendingDescendants({
      events: [
        subagentCalled({ callId: "call-1", childSessionId: "child-1", turnId: "turn_0" }),
        subagentCalled({ callId: "call-2", childSessionId: "child-2", turnId: "turn_1" }),
      ],
      turnId: "turn_1",
    });

    expect(records).toEqual([expect.objectContaining({ childSessionId: "child-2" })]);
  });

  it("captures remote identity and ignores malformed events", () => {
    const records = collectPendingDescendants({
      events: [
        "not-an-event",
        { type: "subagent.called", data: { callId: 42 } },
        subagentCalled({
          callId: "call-r",
          childSessionId: "remote-child",
          remote: { url: "https://remote.example.com" },
        }),
      ],
    });

    expect(records).toEqual([
      expect.objectContaining({
        childSessionId: "remote-child",
        remote: { url: "https://remote.example.com" },
      }),
    ]);
  });
});

describe("cancelTurnWithDescendantFanout", () => {
  it("cancels the target and every unresolved local descendant at request time", async () => {
    installEventStreams({
      parent: [subagentCalled({ callId: "call-1", childSessionId: "child-1" })],
    });
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });

    const result = await cancelTurnWithDescendantFanout({ sessionId: "parent" });

    expect(result).toEqual({ status: "accepted" });
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "parent" });
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "child-1" });
  });

  it("recurses into local descendants to cancel grandchildren", async () => {
    installEventStreams({
      "child-1": [subagentCalled({ callId: "call-2", childSessionId: "grandchild-1" })],
      grandchild: [],
      parent: [subagentCalled({ callId: "call-1", childSessionId: "child-1" })],
    });
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });

    await cancelTurnWithDescendantFanout({ sessionId: "parent" });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "grandchild-1" });
  });

  it("skips already-visited sessions so cycles cannot recurse forever", async () => {
    installEventStreams({
      "child-1": [subagentCalled({ callId: "call-back", childSessionId: "parent" })],
      parent: [subagentCalled({ callId: "call-1", childSessionId: "child-1" })],
    });
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });

    await cancelTurnWithDescendantFanout({ sessionId: "parent" });

    const cancelledSessions = vi
      .mocked(requestWorkflowTurnCancellation)
      .mock.calls.map(([input]) => input.sessionId);
    expect(cancelledSessions).toEqual(["parent", "child-1"]);
  });

  it("cancels remote descendants through the url-matched registry node", async () => {
    installEventStreams({
      parent: [
        subagentCalled({
          callId: "call-r",
          childSessionId: "remote-child",
          remote: { url: "https://remote.example.com" },
        }),
      ],
    });
    const remoteNode = { kind: "remote", name: "child", url: "https://remote.example.com" };
    const registry = new Map([["subagents/remote", { definition: remoteNode }]]);
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn).mockResolvedValue({ status: "accepted" });

    await cancelTurnWithDescendantFanout({
      resolveRemoteRegistry: async () => registry as never,
      sessionId: "parent",
    });

    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith({
      remote: remoteNode,
      sessionId: "remote-child",
    });
    // Remote descendants are cancelled by their own deployment; no local recursion.
    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalledWith({
      sessionId: "remote-child",
    });
  });

  it("defers a remote descendant whose url matches no registered agent", async () => {
    installEventStreams({
      parent: [
        subagentCalled({
          callId: "call-r",
          childSessionId: "remote-child",
          remote: { url: "https://unknown.example.com" },
        }),
      ],
    });
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await cancelTurnWithDescendantFanout({
      resolveRemoteRegistry: async () => new Map() as never,
      sessionId: "parent",
    });

    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("matched no registered remote agent"),
      expect.anything(),
    );
  });

  it("retries a local child caught in its dispatch gap", async () => {
    vi.useFakeTimers();
    try {
      installEventStreams({
        parent: [subagentCalled({ callId: "call-1", childSessionId: "child-1" })],
      });
      vi.mocked(requestWorkflowTurnCancellation)
        .mockResolvedValueOnce({ status: "accepted" }) // parent
        .mockResolvedValueOnce({ reason: "HookNotFoundError", status: "no_active_turn" })
        .mockResolvedValueOnce({ status: "accepted" });

      const fanout = cancelTurnWithDescendantFanout({ sessionId: "parent" });
      await vi.advanceTimersByTimeAsync(1_000);
      await fanout;

      const childCancels = vi
        .mocked(requestWorkflowTurnCancellation)
        .mock.calls.filter(([input]) => input.sessionId === "child-1");
      expect(childCancels).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the target result even when fan-out fails", async () => {
    vi.mocked(getRun).mockImplementation(() => {
      throw new Error("world unavailable");
    });
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cancelTurnWithDescendantFanout({ sessionId: "parent" });

    expect(result).toEqual({ status: "accepted" });
    expect(error).toHaveBeenCalled();
  });

  it("still fans out when the target itself has no active turn", async () => {
    installEventStreams({
      parent: [subagentCalled({ callId: "call-1", childSessionId: "orphan-child" })],
    });
    vi.mocked(requestWorkflowTurnCancellation)
      .mockResolvedValueOnce({ reason: "HookNotFoundError", status: "no_active_turn" })
      .mockResolvedValue({ status: "accepted" });

    const result = await cancelTurnWithDescendantFanout({ sessionId: "parent" });

    expect(result).toEqual({ reason: "HookNotFoundError", status: "no_active_turn" });
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "orphan-child" });
  });
});
