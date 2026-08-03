import {
  isInboxResultFromRunningHandle,
  isResultBoundToRunningHandle,
} from "#harness/handles/query.js";
import { describe, expect, it } from "vitest";

import {
  getPendingRuntimeActionBatch,
  resolvePendingRuntimeActions,
  resolveToolCallInputObject,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { deriveAgentId, getAgentHandleStore } from "#harness/handles/store.js";
import {
  confirmAgentStarted,
  prepareAgentContinuation,
  prepareAgentStart,
} from "#harness/handles/transitions.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const CHILD_SESSION_ID = "local-child-123456789012";
const CHILD_CONTINUATION_TOKEN = "subagent:private-token";
const ZERO_USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
} as const;
const OPERATION_ID = deriveAgentOperationId({
  callId: "call-1",
  parentSessionId: "test-session",
  parentTurnId: "turn_0",
});

function createParkedSession(): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [{ content: "delegate this", role: "user" }],
    sessionId: "test-session",
  };

  const ownUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    sawCost: false,
  };
  const withUsage = setTurnUsageState(base, {
    ...ownUsage,
    session: ownUsage,
    turnId: "turn_0",
  });

  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "research subagent",
        input: { description: "Research the topic", message: "go" },
        kind: "subagent-call",
        name: "researcher",
        nodeId: "subagents/researcher",
        subagentName: "researcher",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: withUsage,
  });
}

/** Parked session whose call-1 child is owned by a running agent handle. */
function createSessionWithRunningChild(): HarnessSession {
  const prepared = prepareAgentStart(createParkedSession(), {
    identity: {
      id: deriveAgentId("researcher", OPERATION_ID),
      name: "researcher",
      nodeId: "subagents/researcher",
    },
    operation: {
      callId: "call-1",
      id: OPERATION_ID,
      kind: "start",
      parentTurnId: "turn_0",
    },
    target: { continuationToken: CHILD_CONTINUATION_TOKEN, kind: "agent/local" },
  });
  return confirmAgentStarted(prepared, {
    address: {
      continuationToken: CHILD_CONTINUATION_TOKEN,
      kind: "agent/local",
      sessionId: CHILD_SESSION_ID,
    },
    operationId: OPERATION_ID,
  });
}

describe("resolvePendingRuntimeActions", () => {
  it("marks a working task receipt as backgrounded on subagent.completed", async () => {
    const events: UnstampedMessageStreamEvent[] = [];
    const taskId = "task_0123456789abcdef";

    await resolvePendingRuntimeActions({
      emit: async (event) => {
        events.push(event);
      },
      session: createSessionWithRunningChild(),
      stepInput: {
        runtimeActionResults: [
          {
            backgroundTask: { status: "working", taskId },
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: "delegated" },
              usageDelta: ZERO_USAGE,
            },
            output: { status: "working", taskId },
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(events.find((event) => event.type === "subagent.completed")).toMatchObject({
      data: { backgroundTask: { status: "working", taskId } },
    });
  });

  it("settles the running handle terminally and deletes it with the batch", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "done" },
              usageDelta: ZERO_USAGE,
            },
            output: "done",
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getPendingRuntimeActionBatch(resolved.session.state)).toBeUndefined();
    expect(getAgentHandleStore(resolved.session.state)).toEqual({ handles: [] });
  });

  it("settles a sessionId-less result from an older deployment by callId", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "done" },
              usageDelta: ZERO_USAGE,
            },
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getAgentHandleStore(resolved.session.state)).toEqual({ handles: [] });
  });

  it("settles a failed child result terminally as well", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: {
                error: { code: "SESSION_FAILED", message: "child failed" },
                kind: "failed",
              },
              usageDelta: ZERO_USAGE,
            },
            output: { code: "SESSION_FAILED", message: "child failed" },
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getAgentHandleStore(resolved.session.state)).toEqual({ handles: [] });
  });

  it("clears the child's proxy-input entries before settling its handle", async () => {
    const session = upsertProxyInputRequests({
      entries: [
        ["request-1", { childContinuationToken: CHILD_CONTINUATION_TOKEN, kind: "question" }],
      ],
      forChildContinuationToken: CHILD_CONTINUATION_TOKEN,
      session: createSessionWithRunningChild(),
    });

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "done" },
              usageDelta: ZERO_USAGE,
            },
            output: "done",
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getProxyInputRequests(resolved.session.state).size).toBe(0);
  });

  it("ignores a result that claims a session no running handle confirms", async () => {
    const session = createSessionWithRunningChild();

    const wrongChild = {
      callId: "call-1",
      kind: "subagent-result",
      outcome: {
        kind: "terminal",
        result: { kind: "succeeded", output: "forged" },
        usageDelta: ZERO_USAGE,
      },
      output: "forged",
      sessionId: "forged-sibling-session",
      subagentName: "researcher",
    } as const;

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: { runtimeActionResults: [wrongChild] },
    });

    expect(resolved.outcome).toBe("unresolved");
    // The genuine child stays owned and running.
    expect(getAgentHandleStore(resolved.session.state)?.handles).toHaveLength(1);
  });

  it("accepts a dispatch-failure result with no sessionId by callId", async () => {
    const resolved = await resolvePendingRuntimeActions({
      session: createParkedSession(),
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            output: { code: "SUBAGENT_START_FAILED", message: "boom" },
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getPendingRuntimeActionBatch(resolved.session.state)).toBeUndefined();
  });

  it("draws completed child usage down against the parent's session totals", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "done" },
              usageDelta: {
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                inputTokens: 4_000,
                outputTokens: 400,
              },
            },
            output: "done",
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 4_000,
              outputTokens: 400,
            },
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 500,
    });
  });

  it("keeps a parked handle resumable — even for a failed turn — and deletes a terminal one", async () => {
    const session = createSessionWithRunningChild();
    const agentId = deriveAgentId("researcher", OPERATION_ID);

    const parkedResolve = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            outcome: {
              kind: "parked",
              result: {
                error: { code: "SUBAGENT_EXECUTION_FAILED", message: "schema not fulfilled" },
                kind: "failed",
              },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            },
            output: { code: "SUBAGENT_EXECUTION_FAILED", message: "schema not fulfilled" },
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(parkedResolve.outcome).toBe("resolved");
    expect(getAgentHandleStore(parkedResolve.session.state)?.handles).toEqual([
      expect.objectContaining({ phase: "parked" }),
    ]);

    // The parked handle stays resumable: a continuation prepares cleanly.
    const continueOperationId = deriveAgentOperationId({
      callId: "call-2",
      parentSessionId: "test-session",
      parentTurnId: "turn_1",
    });
    const continued = prepareAgentContinuation(parkedResolve.session, {
      agentId,
      invokedName: "researcher",
      operation: {
        callId: "call-2",
        id: continueOperationId,
        kind: "continue",
        parentTurnId: "turn_1",
        previousStatus: "",
      },
    });
    expect(continued.kind).toBe("ready");
    if (continued.kind !== "ready") throw new Error("expected ready continuation");

    // A terminal failure on the follow-up turn deletes the handle.
    const secondBatch = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-2",
          description: "research subagent",
          input: { agentId, message: "continue" },
          kind: "subagent-call",
          name: "researcher",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      ],
      event: { sequence: 1, stepIndex: 0, turnId: "turn_1" },
      responseMessages: [],
      session: continued.session,
    });
    const terminalResolve = await resolvePendingRuntimeActions({
      session: secondBatch,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-2",
            isError: true,
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: {
                error: { code: "SUBAGENT_EXECUTION_FAILED", message: "child crashed" },
                kind: "failed",
              },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            },
            output: { code: "SUBAGENT_EXECUTION_FAILED", message: "child crashed" },
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(terminalResolve.outcome).toBe("resolved");
    expect(getAgentHandleStore(terminalResolve.session.state)).toEqual({ handles: [] });
  });

  it("folds each turn's usage delta once so a two-turn child never double-counts", async () => {
    // Turn 1: the child spent 4000/400 and parked.
    const session = createSessionWithRunningChild();
    const agentId = deriveAgentId("researcher", OPERATION_ID);
    const firstResolve = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: "first answer" },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 4_000,
                outputTokens: 400,
              },
            },
            output: "first answer",
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
            // Cumulative child-session totals: folding these instead of the
            // delta would double-count turn 1 on the next settlement.
            usage: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 4_000,
              outputTokens: 400,
            },
          },
        ],
      },
    });
    expect(getSessionTokenUsage(firstResolve.session)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 500,
    });

    // Turn 2: the child spent another 1000/100 (cumulative 5000/500).
    const continued = prepareAgentContinuation(firstResolve.session, {
      agentId,
      invokedName: "researcher",
      operation: {
        callId: "call-2",
        id: deriveAgentOperationId({
          callId: "call-2",
          parentSessionId: "test-session",
          parentTurnId: "turn_1",
        }),
        kind: "continue",
        parentTurnId: "turn_1",
        previousStatus: "",
      },
    });
    if (continued.kind !== "ready") throw new Error("expected ready continuation");
    const secondBatch = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-2",
          description: "research subagent",
          input: { agentId, message: "continue" },
          kind: "subagent-call",
          name: "researcher",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      ],
      event: { sequence: 1, stepIndex: 0, turnId: "turn_1" },
      responseMessages: [],
      session: continued.session,
    });
    const secondResolve = await resolvePendingRuntimeActions({
      session: secondBatch,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-2",
            kind: "subagent-result",
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: "second answer" },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 1_000,
                outputTokens: 100,
              },
            },
            output: "second answer",
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
            usage: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 5_000,
              outputTokens: 500,
            },
          },
        ],
      },
    });

    // Own 1000/100 + turn deltas (4000+1000)/(400+100) — never the child's
    // cumulative 5000/500 twice.
    expect(getSessionTokenUsage(secondResolve.session)).toMatchObject({
      inputTokens: 6_000,
      outputTokens: 600,
    });
  });

  it("leaves the parent's totals untouched when the child reports a zero usage delta", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "done" },
              usageDelta: ZERO_USAGE,
            },
            output: "done",
            sessionId: CHILD_SESSION_ID,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    });
  });
});

describe("result-to-handle binding", () => {
  const boundResult = {
    callId: "call-1",
    kind: "subagent-result",
    outcome: {
      kind: "terminal",
      result: { kind: "succeeded", output: "done" },
      usageDelta: ZERO_USAGE,
    },
    output: "done",
    sessionId: CHILD_SESSION_ID,
    subagentName: "researcher",
  } as const;

  it("accepts only results a running handle binds by callId and sessionId", () => {
    const state = createSessionWithRunningChild().state;

    for (const bound of [isResultBoundToRunningHandle, isInboxResultFromRunningHandle]) {
      expect(bound(state, boundResult)).toBe(true);
      expect(bound(state, { ...boundResult, sessionId: "forged-sibling" })).toBe(false);
      expect(bound(state, { ...boundResult, callId: "call-other" })).toBe(false);
      expect(
        bound(state, { callId: "call-1", kind: "tool-result", output: "", toolName: "x" }),
      ).toBe(true);
    }
  });

  it("binds sessionId-less inbox results by callId alone, as older deployments send them", () => {
    // Older eve deployments claim no sessionId. Their results bind to the
    // running handle by callId; a callId with no running handle — one whose
    // dispatch already failed — still finds nothing and cannot overwrite
    // the dispatch-produced error result.
    const legacyShaped = {
      callId: "call-1",
      kind: "subagent-result",
      outcome: {
        kind: "terminal",
        result: { kind: "succeeded", output: "done" },
        usageDelta: ZERO_USAGE,
      },
      output: "done",
      subagentName: "researcher",
    } as const;
    const state = createSessionWithRunningChild().state;

    expect(isResultBoundToRunningHandle(state, legacyShaped)).toBe(true);
    expect(isInboxResultFromRunningHandle(state, legacyShaped)).toBe(true);
    expect(isInboxResultFromRunningHandle(state, { ...legacyShaped, callId: "call-unknown" })).toBe(
      false,
    );
  });
});

describe("resolveToolCallInputObject", () => {
  const context = { callId: "call-1", toolName: "web_search" };

  it("passes plain objects through", () => {
    expect(resolveToolCallInputObject({ query: "eve" }, context)).toEqual({ query: "eve" });
  });

  it("treats undefined, null, and empty-string inputs as empty arguments", () => {
    expect(resolveToolCallInputObject(undefined, context)).toEqual({});
    expect(resolveToolCallInputObject(null, context)).toEqual({});
    expect(resolveToolCallInputObject("", context)).toEqual({});
    expect(resolveToolCallInputObject("  ", context)).toEqual({});
  });

  it("parses raw JSON-string inputs from provider-executed tool calls", () => {
    expect(resolveToolCallInputObject('{"query":"eve"}', context)).toEqual({ query: "eve" });
  });

  it("rejects strings that are not JSON objects, naming the tool and call", () => {
    expect(() => resolveToolCallInputObject('"query"', context)).toThrow(
      /web_search.*call-1.*Expected a JSON-serializable object/su,
    );

    try {
      resolveToolCallInputObject("not json", context);
      expect.unreachable("malformed JSON should throw");
    } catch (error) {
      expect(error).toMatchObject({
        cause: expect.objectContaining({ name: "SyntaxError" }),
      });
      expect((error as Error).message).toMatch(/web_search.*call-1/su);
      expect((error as Error).message).not.toContain("Expected a JSON-serializable object.");
    }
  });

  it("rejects non-object JSON values", () => {
    expect(() => resolveToolCallInputObject(42, context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
    expect(() => resolveToolCallInputObject(["a"], context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
  });
});
