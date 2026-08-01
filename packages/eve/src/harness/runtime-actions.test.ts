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
import { confirmAgentStarted, prepareAgentStart } from "#harness/handles/transitions.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

const CHILD_SESSION_ID = "local-child-123456789012";
const CHILD_CONTINUATION_TOKEN = "subagent:private-token";
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
  it("settles the running handle terminally and deletes it with the batch", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            claim: { kind: "session", sessionId: CHILD_SESSION_ID },
            kind: "subagent-result",
            origin: "child",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getPendingRuntimeActionBatch(resolved.session.state)).toBeUndefined();
    expect(getAgentHandleStore(resolved.session.state)).toEqual({ handles: [] });
  });

  it("settles a call-only claim from an older deployment by callId", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            claim: { kind: "call-only" },
            kind: "subagent-result",
            origin: "child",
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
            claim: { kind: "session", sessionId: CHILD_SESSION_ID },
            isError: true,
            kind: "subagent-result",
            origin: "child",
            output: { code: "SESSION_FAILED", message: "child failed" },
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
            claim: { kind: "session", sessionId: CHILD_SESSION_ID },
            kind: "subagent-result",
            origin: "child",
            output: "done",
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
      claim: { kind: "session", sessionId: "forged-sibling-session" },
      kind: "subagent-result",
      origin: "child",
      output: "forged",
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

  it("accepts a dispatch-origin failure result by callId", async () => {
    const resolved = await resolvePendingRuntimeActions({
      session: createParkedSession(),
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            origin: "dispatch",
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
            claim: { kind: "session", sessionId: CHILD_SESSION_ID },
            kind: "subagent-result",
            origin: "child",
            output: "done",
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

  it("leaves the parent's totals untouched when the child reports no usage", async () => {
    const session = createSessionWithRunningChild();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            claim: { kind: "session", sessionId: CHILD_SESSION_ID },
            kind: "subagent-result",
            origin: "child",
            output: "done",
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
    claim: { kind: "session", sessionId: CHILD_SESSION_ID },
    kind: "subagent-result",
    origin: "child",
    output: "done",
    subagentName: "researcher",
  } as const;

  it("accepts only results a running handle binds by callId and sessionId", () => {
    const state = createSessionWithRunningChild().state;

    for (const bound of [isResultBoundToRunningHandle, isInboxResultFromRunningHandle]) {
      expect(bound(state, boundResult)).toBe(true);
      expect(
        bound(state, { ...boundResult, claim: { kind: "session", sessionId: "forged-sibling" } }),
      ).toBe(false);
      expect(bound(state, { ...boundResult, callId: "call-other" })).toBe(false);
      expect(
        bound(state, { callId: "call-1", kind: "tool-result", output: "", toolName: "x" }),
      ).toBe(true);
    }
  });

  it("binds call-only claims by callId alone, as older deployments send them", () => {
    // Older eve deployments claim no session (`call-only`). Their results
    // bind to the running handle by callId; a callId with no running handle
    // — one whose dispatch already failed — still finds nothing and cannot
    // overwrite the dispatch-produced error result.
    const legacyShaped = {
      callId: "call-1",
      claim: { kind: "call-only" },
      kind: "subagent-result",
      origin: "child",
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

  it("rejects dispatch-origin results on the inbox while the step path trusts them", () => {
    // Dispatch failures are parent-synthesized and only travel the trusted
    // step-result path; one arriving over the shared inbox is a forgery.
    const dispatchFailure = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: { code: "SUBAGENT_START_FAILED", message: "boom" },
      subagentName: "researcher",
    } as const;
    const state = createSessionWithRunningChild().state;

    expect(isResultBoundToRunningHandle(state, dispatchFailure)).toBe(true);
    expect(isInboxResultFromRunningHandle(state, dispatchFailure)).toBe(false);
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
