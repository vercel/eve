import { ContextContainer } from "#context/container.js";
import { beforeEach, expect, it, vi } from "vitest";
import { cancelBackgroundAgentTask, cancelAgentInvocationOwnerStep } from "./task-cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { deserializeContext } from "#context/serialize.js";
import { cancelRemoteAgentTurn, resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";
import { setAgentHandleStore, type AgentHandle } from "#subagents/handles/store.js";
import type { TaskWorkflowInvocation } from "#harness/workflow-invocations.js";

vi.mock("#execution/workflow-runtime.js", () => ({ requestWorkflowTurnCancellation: vi.fn() }));
vi.mock("#execution/durable-session-store.js", () => ({ readDurableSession: vi.fn() }));
vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#context/dynamic-subagent-lifecycle.js", () => ({ getDynamicSubagentSelection: vi.fn() }));
vi.mock("#subagents/remote-dispatch.js", () => ({
  cancelRemoteAgentTurn: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
}));
vi.mock("#internal/logging.js", () => ({ createLogger: vi.fn(() => ({})), logError: vi.fn() }));

const entry: TaskWorkflowInvocation = {
  callId: "call",
  toolName: "research",
  resultKind: "tool",
  lifetime: "session",
  origin: { turnId: "turn", stepIndex: 0 },
  address: { runId: "run", hookToken: "hook" },
  task: {
    taskId: "owner",
    metadata: { kind: "tool", name: "research" },
    dispatchContext: { auth: { current: null, initiator: null } },
  },
};
const claimed = (id: string, ownerId = "owner"): AgentHandle => ({
  phase: "claimed",
  ownerId,
  operationId: `op-${id}`,
  identity: { id, name: "research", nodeId: "subagents/research" },
  address: { kind: "agent/local", sessionId: id, continuationToken: `token-${id}` },
});
const session = {
  state: setAgentHandleStore(undefined, {
    handles: [
      claimed("child-a"),
      claimed("child-b"),
      claimed("other-child", "other-owner"),
      {
        phase: "available",
        identity: { id: "idle", name: "research", nodeId: "subagents/research" },
        address: { kind: "agent/local", sessionId: "idle", continuationToken: "idle" },
      },
    ],
  }),
};

beforeEach(() => vi.resetAllMocks());

it.each(["background", "waiting"])(
  "cancels every claimed child of a %s owner, leaving unrelated children alone",
  async (mode) => {
    if (mode === "background") {
      await cancelBackgroundAgentTask({ entry, session, serializedContext: {} });
    } else {
      vi.mocked(readDurableSession).mockReturnValue(
        session as ReturnType<typeof readDurableSession>,
      );
      await cancelAgentInvocationOwnerStep({
        ownerId: "owner",
        serializedContext: {},
        sessionState: {} as Parameters<typeof cancelAgentInvocationOwnerStep>[0]["sessionState"],
      });
    }
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledTimes(2);
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "child-a" });
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({ sessionId: "child-b" });
    expect(deserializeContext).not.toHaveBeenCalled();
  },
);

it("propagates child cancellation failure so background cancellation can retry", async () => {
  vi.mocked(requestWorkflowTurnCancellation).mockRejectedValueOnce(new Error("unavailable"));
  await expect(
    cancelBackgroundAgentTask({ entry, session, serializedContext: {} }),
  ).rejects.toThrow("Failed to cancel owned agent turns");
  expect(requestWorkflowTurnCancellation).toHaveBeenCalledTimes(2);
});

it("waits for sibling cancellation requests before returning a failure", async () => {
  let release!: () => void;
  vi.mocked(requestWorkflowTurnCancellation)
    .mockRejectedValueOnce(new Error("first child failed"))
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "accepted", sessionId: "child-b" };
    });
  const cancellation = cancelBackgroundAgentTask({ entry, session, serializedContext: {} });
  const rejected = vi.fn();
  cancellation.catch(rejected);
  await Promise.resolve();
  await Promise.resolve();
  expect(rejected).not.toHaveBeenCalled();
  release();
  await expect(cancellation).rejects.toThrow("Failed to cancel owned agent turns");
});

it("cancels remote children at their recorded address", async () => {
  const remoteSession = {
    state: setAgentHandleStore(undefined, {
      handles: [
        {
          ...claimed("remote"),
          phase: "claimed",
          ownerId: "owner",
          operationId: "op-remote",
          address: {
            kind: "agent/remote",
            sessionId: "remote",
            url: "https://original.example",
            callbackBaseUrl: "https://parent.example",
          },
        },
      ],
    }),
  };
  const ctx = new ContextContainer();
  vi.spyOn(ctx, "require").mockReturnValue({ subagentRegistry: { subagentsByNodeId: new Map() } });
  vi.mocked(deserializeContext).mockResolvedValue(ctx);
  vi.mocked(resolveRemoteAgentForAction).mockReturnValue({
    url: "https://new.example",
  } as ReturnType<typeof resolveRemoteAgentForAction>);
  await cancelBackgroundAgentTask({ entry, session: remoteSession, serializedContext: {} });
  expect(cancelRemoteAgentTurn).toHaveBeenCalledWith({
    remote: { url: "https://original.example" },
    sessionId: "remote",
  });
});
