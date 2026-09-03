import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  dispatchAgentInvocation,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invoke-preparation.js";
import { dispatchToClaimedAgentAddress } from "#subagents/handle-dispatch.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";

vi.mock("#execution/tools/subagent/invoke-preparation.js", () => ({
  prepareOwnerAgentInvocation: vi.fn(),
}));
vi.mock("#subagents/handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchToClaimedAgentAddress: vi.fn(),
}));

const address = {
  continuationToken: "child-token",
  kind: "agent/local" as const,
  sessionId: "child-session",
};
const identity = { id: "agent-1", name: "research", nodeId: "subagents/research" };

describe("blocking workflow agent continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareOwnerAgentInvocation).mockImplementation(async (input) => {
      const session = await readDurableSession(input.sessionState);
      return {
        adapter: {},
        adapterCtx: {},
        auth: null,
        batch: { event: { sequence: 1, stepIndex: 0, turnId: "turn-1" } },
        bundle: {},
        capabilities: undefined,
        channelMetadata: undefined,
        fanoutSize: 1,
        initiatorAuth: null,
        parentTraceContext: undefined,
        plan: [
          {
            action: {
              callId: input.invocationId,
              description: "Research",
              input: input.invocation,
              kind: "subagent-call",
              name: "research",
              nodeId: identity.nodeId,
              subagentName: identity.name,
            },
            agentId: identity.id,
            kind: "resume",
          },
        ],
        sandboxSessionId: "parent",
        serializedContext: {},
        session: {
          ...session,
          compaction: { recentWindowSize: 5, threshold: 10_000 },
        },
      } as never;
    });
    vi.mocked(dispatchToClaimedAgentAddress).mockImplementation(async (input) => ({
      address,
      callId: input.action.callId,
      kind: "called",
      name: "research",
      session: input.currentSession,
      toolName: "research",
    }));
  });

  it("reuses one handle for two calls from the same workflow run", async () => {
    const session = {
      agent: { dynamicModel: true as const, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent",
      state: setAgentHandleStore(undefined, {
        handles: [{ address, identity, phase: "available" }],
      }),
    };
    let sessionState = createDurableSessionState({ session });

    for (const [index, message] of ["first", "second"].entries()) {
      const callId = `workflow-call:${String(index)}`;
      const dispatched = await dispatchAgentInvocation({
        callbackBaseUrl: "https://parent.example",
        ownerId: "workflow-run-1",
        replyTo: `reply-${String(index)}`,
        request: {
          input: { agentId: identity.id, message, target: identity.name },
          invocationId: callId,
          kind: "agent-invoke",
        },
        serializedContext: {},
        sessionState,
      });
      expect(dispatched).toMatchObject({ agentId: identity.id, kind: "dispatched" });
      if (dispatched.kind !== "dispatched") throw new Error("Expected dispatch.");
      const claimed = getAgentHandleStore(dispatched.sessionState.snapshot?.session.state)?.handles;
      expect(claimed).toEqual([
        expect.objectContaining({ identity, ownerId: "workflow-run-1", phase: "claimed" }),
      ]);

      const settled = await settleTaskAgentInvocationStep({
        ownerId: "workflow-run-1",
        result: {
          callId,
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "parked",
            result: { kind: "succeeded", output: message },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: message,
          subagentName: identity.name,
        },
        serializedContext: dispatched.serializedContext,
        sessionState: dispatched.sessionState,
      });
      sessionState = settled.sessionState;
      expect(getAgentHandleStore(sessionState.snapshot?.session.state)?.handles).toEqual([
        { address, identity, phase: "available" },
      ]);
    }

    expect(dispatchToClaimedAgentAddress).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(dispatchToClaimedAgentAddress).mock.calls.map(([input]) => input.handle.address),
    ).toEqual([address, address]);
  });
});
