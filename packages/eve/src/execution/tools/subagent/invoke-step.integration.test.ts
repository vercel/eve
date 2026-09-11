import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import {
  dispatchAgentInvocation,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invoke-preparation.js";
import { dispatchToClaimedAgentAddress } from "#subagents/handle-dispatch.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";

vi.mock("#execution/tools/subagent/invoke-preparation.js", () => ({
  prepareOwnerAgentInvocation: vi.fn(),
}));
vi.mock("#subagents/handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchToClaimedAgentAddress: vi.fn(),
}));
vi.mock("#execution/tools/subagent/start.js", () => ({ startSubagent: vi.fn() }));

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
      const session = readDurableSession(input.sessionState);
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

  it("forwards inherited activity when starting a background subagent", async () => {
    const activityObserver = {
      sink: { url: "https://parent.example/activity", version: 1 as const },
      workIdentity: {
        id: "work:task",
        kind: "task" as const,
        name: "slack",
        parentId: "work:root",
        rootSessionId: "root-session",
        rootTurnId: "root-turn",
      },
    };
    vi.mocked(prepareOwnerAgentInvocation).mockResolvedValue({
      activityObserver,
      auth: null,
      batch: { event: { sequence: 1, stepIndex: 0, turnId: "turn-1" } },
      bundle: {},
      capabilities: undefined,
      channelMetadata: undefined,
      fanoutSize: 1,
      initiatorAuth: null,
      localDevRequest: undefined,
      parentTraceContext: undefined,
      plan: [
        {
          kind: "start",
          target: {
            action: {
              callId: "call-1",
              description: "Research",
              input: { message: "Search Slack", target: "slack" },
              kind: "subagent-call",
              name: "slack",
              nodeId: "subagents/slack",
              subagentName: "slack",
            },
            kind: "local",
            source: { description: "Search Slack", type: "local" },
          },
        },
      ],
      sandboxSessionId: "parent",
      serializedContext: {},
      session: {
        agent: { dynamicModel: true as const, system: "", tools: [] },
        compaction: { recentWindowSize: 5, threshold: 10_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent",
      },
    } as never);
    vi.mocked(startSubagent).mockResolvedValue({
      address: { continuationToken: "child-token", kind: "agent/local", sessionId: "child" },
      callId: "call-1",
      kind: "called",
      name: "slack",
      session: {} as never,
      toolName: "slack",
    });

    await dispatchAgentInvocation({
      callbackBaseUrl: "https://parent.example",
      ownerId: "workflow-run-1",
      replyTo: "reply-1",
      request: {
        input: { message: "Search Slack", target: "slack" },
        invocationId: "call-1",
        kind: "agent-invoke",
      },
      serializedContext: {},
      sessionState: createDurableSessionState({
        session: {
          agent: { dynamicModel: true as const, system: "", tools: [] },
          compaction: { recentWindowSize: 5, threshold: 10_000 },
          continuationToken: "parent-token",
          history: [],
          sessionId: "parent",
        },
      }),
    });

    expect(startSubagent).toHaveBeenCalledWith(expect.objectContaining({ activityObserver }));
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
      const claimed = getAgentHandleStore(dispatched.sessionState.snapshot.session.state)?.handles;
      expect(claimed).toEqual([
        expect.objectContaining({ identity, ownerId: "workflow-run-1", phase: "claimed" }),
      ]);

      const settled = await settleTaskAgentInvocationStep({
        serializedContext: dispatched.serializedContext ?? {},
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
        sessionState: dispatched.sessionState,
      });
      sessionState = settled.sessionState;
      expect(getAgentHandleStore(sessionState.snapshot.session.state)?.handles).toEqual([
        { address, identity, phase: "available" },
      ]);
    }

    expect(dispatchToClaimedAgentAddress).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(dispatchToClaimedAgentAddress).mock.calls.map(([input]) => input.handle.address),
    ).toEqual([address, address]);
  });
});
