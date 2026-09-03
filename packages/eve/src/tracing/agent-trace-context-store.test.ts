import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ParentTraceContextKey, SessionTraceSeedKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  ContextAgentTraceStateStore,
  preserveSerializedAgentTraceState,
  recordActionChildTraceId,
  recordNestedAgentInvocation,
  recordNestedAgentInvocationTerminal,
  readActionTraceContext,
  readCurrentSessionTraceDecision,
  readSessionTraceContext,
} from "#tracing/agent-trace-context-store.js";

describe("ContextAgentTraceStateStore", () => {
  it("restores serializable session and turn context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      store.setSession("session-1", {
        agentName: "weather",
        context: spanContext("1", "2"),
        parentLineage: {
          callId: "call-parent",
          sessionId: "parent-session",
          turnId: "parent-turn",
        },
        rootSessionId: "session-1",
      });
      store.setTurn("session-1", "turn-1", {
        context: spanContext("1", "3"),
        currentPrincipal: { fingerprint: "current", type: "user" },
        initiatorPrincipal: { type: "none" },
        modelUsage: { inputTokens: 12, outputTokens: 4 },
        parentIsRemote: true,
        parentSpanId: "2".repeat(16),
        parentLineage: {
          callId: "call-current",
          sessionId: "parent-session",
          turnId: "parent-turn-2",
        },
        rootSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1_700_000_000_000,
        subagentName: "researcher",
        terminal: { error: new Error("failed"), type: "turn.failed" },
      });
    });

    const serialized = await serializeContext(context);
    const restored = await deserializeContext(serialized);
    await contextStorage.run(restored, () => {
      const store = new ContextAgentTraceStateStore();
      expect(store.getSession("session-1")?.context).toEqual(spanContext("1", "2"));
      expect(store.getSession("session-1")?.parentLineage).toMatchObject({
        callId: "call-parent",
      });
      expect(store.getTurn("session-1", "turn-1")?.context).toEqual(spanContext("1", "3"));
      expect(store.getTurn("session-1", "turn-1")).toMatchObject({
        modelUsage: { inputTokens: 12, outputTokens: 4 },
        currentPrincipal: { fingerprint: "current", type: "user" },
        initiatorPrincipal: { type: "none" },
        parentLineage: { callId: "call-current" },
        parentIsRemote: true,
        parentSpanId: "2".repeat(16),
        startTimeMs: 1_700_000_000_000,
        subagentName: "researcher",
      });
      const terminal = store.getTurn("session-1", "turn-1")?.terminal;
      expect(terminal?.type).toBe("turn.failed");
      expect(terminal?.type === "turn.failed" ? terminal.error : undefined).toMatchObject({
        message: "failed",
      });
    });
  });

  it("removes terminal state", () => {
    contextStorage.run(new ContextContainer(), () => {
      const store = new ContextAgentTraceStateStore();
      store.setSession("session-1", {
        context: spanContext("1", "2"),
        rootSessionId: "session-1",
      });
      store.setTurn("session-1", "turn-1", {
        context: spanContext("1", "3"),
        parentSpanId: "2".repeat(16),
        rootSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1_700_000_000_000,
      });

      store.deleteTurn("session-1", "turn-1");
      store.deleteSession("session-1");

      expect(store.getTurn("session-1", "turn-1")).toBeUndefined();
      expect(store.getSession("session-1")).toBeUndefined();
    });
  });

  it("composes atomic turn updates without recreating deleted turns", () => {
    contextStorage.run(new ContextContainer(), () => {
      const store = new ContextAgentTraceStateStore();
      store.setTurn("session-1", "turn-1", {
        context: spanContext("1", "3"),
        parentSpanId: "2".repeat(16),
        rootSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1_700_000_000_000,
      });

      store.updateTurn("session-1", "turn-1", (turn) => ({
        ...turn,
        modelUsage: { inputTokens: 12, outputTokens: 4 },
      }));
      store.updateTurn("session-1", "turn-1", (turn) => ({
        ...turn,
        terminal: { type: "turn.completed" },
      }));

      expect(store.getTurn("session-1", "turn-1")).toMatchObject({
        modelUsage: { inputTokens: 12, outputTokens: 4 },
        terminal: { type: "turn.completed" },
      });
      store.deleteTurn("session-1", "turn-1");
      store.updateTurn("session-1", "turn-1", (turn) => ({
        ...turn,
        modelUsage: { inputTokens: 99 },
      }));
      expect(store.getTurn("session-1", "turn-1")).toBeUndefined();
    });
  });

  it("preserves only trace state from an interrupted context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().setSession("session-1", {
        context: spanContext("1", "2"),
        rootSessionId: "session-1",
      });
    });

    const interrupted = await serializeContext(context);
    const preserved = preserveSerializedAgentTraceState({ authored: "original" }, interrupted);

    expect(preserved.authored).toBe("original");
    expect(preserved["eve.harness.agentTrace"]).toBeDefined();
  });

  it("persists a confirmed child trace on the sampled action state", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().setAction("action-key", {
        attemptIndex: 0,
        callId: "call-1",
        kind: "subagent-call",
        name: "researcher",
        parent: spanContext("1", "2"),
        rootSessionId: "root-session",
        sessionId: "parent-session",
        spanId: "3".repeat(16),
        startTimeMs: 1,
        stepIndex: 0,
        turnId: "parent-turn",
      });
    });
    const serialized = recordActionChildTraceId(
      serializeContext(context),
      "parent-session",
      "parent-turn",
      "call-1",
      "4".repeat(32),
    );
    const restored = await deserializeContext(serialized);

    await contextStorage.run(restored, () => {
      expect(new ContextAgentTraceStateStore().getAction("action-key")?.childTraceId).toBe(
        "4".repeat(32),
      );
    });
  });

  it("persists independent nested invocation callers under one outer action", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().setAction("outer", {
        attemptIndex: 0,
        callId: "call-1",
        kind: "tool-call",
        name: "coordinate",
        parent: spanContext("1", "2"),
        rootSessionId: "root-session",
        sessionId: "parent-session",
        spanId: "3".repeat(16),
        startTimeMs: 1,
        stepIndex: 0,
        turnId: "parent-turn",
      });
    });
    let serialized = serializeContext(context);
    serialized = recordNestedAgentInvocation({
      callId: "call-1:first",
      kind: "subagent-call",
      name: "research",
      outerCallId: "call-1",
      serializedContext: serialized,
      sessionId: "parent-session",
      spanId: "4".repeat(16),
      turnId: "parent-turn",
    });
    serialized = recordNestedAgentInvocation({
      callId: "call-1:second",
      kind: "remote-agent-call",
      name: "review",
      outerCallId: "call-1",
      serializedContext: serialized,
      sessionId: "parent-session",
      spanId: "5".repeat(16),
      turnId: "parent-turn",
    });
    serialized = recordActionChildTraceId(
      serialized,
      "parent-session",
      "parent-turn",
      "call-1:second",
      "6".repeat(32),
    );
    serialized = recordNestedAgentInvocationTerminal({
      callId: "call-1:second",
      serializedContext: serialized,
      sessionId: "parent-session",
      terminal: { error: new Error("remote failed"), outcome: "failed" },
    });
    const restored = await deserializeContext(serialized);

    await contextStorage.run(restored, () => {
      const store = new ContextAgentTraceStateStore();
      const children = store.findChildActions("parent-session", "parent-turn", "call-1");
      expect(children.map((child) => child.callId)).toEqual(["call-1:first", "call-1:second"]);
      expect(children[0]).toMatchObject({
        kind: "subagent-call",
        parent: { spanId: "3".repeat(16) },
        parentActionCallId: "call-1",
      });
      expect(children[1]).toMatchObject({
        childTraceId: "6".repeat(32),
        kind: "remote-agent-call",
        terminal: { error: { message: "remote failed" }, outcome: "failed" },
      });
      expect(store.getAction("outer")).toMatchObject({ kind: "tool-call", name: "coordinate" });
    });
  });
});

describe("readSessionTraceContext", () => {
  it("reads one session's trace context out of a serialized context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      context.set(SessionTraceSeedKey, {
        decision: { action: "record", recordInputs: true, recordOutputs: false },
        forwardedTracePolicy: {
          ceiling: { recordInputs: true, recordOutputs: true },
          originAudience: "private",
        },
        spanId: "2".repeat(16),
        traceFlags: 1,
        traceId: "1".repeat(32),
      });
      new ContextAgentTraceStateStore().setSession("session-1", {
        context: spanContext("1", "2"),
        rootSessionId: "session-1",
      });
    });
    const serialized = await serializeContext(context);

    expect(readSessionTraceContext(serialized, "session-1")).toEqual({
      ...spanContext("1", "2"),
      decision: { action: "record", recordInputs: true, recordOutputs: false },
      forwardedTracePolicy: {
        ceiling: { recordInputs: true, recordOutputs: false },
        originAudience: "private",
      },
    });
    expect(readSessionTraceContext(serialized, "session-2")).toBeUndefined();
    expect(readSessionTraceContext({}, "session-1")).toBeUndefined();
  });

  it("preserves a stored decision when the legacy context has no trace seed", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().setSession("session-1", {
        context: spanContext("1", "2"),
        decision: { action: "record", recordInputs: false, recordOutputs: true },
        rootSessionId: "session-1",
      });
    });

    expect(readSessionTraceContext(await serializeContext(context), "session-1")).toEqual({
      ...spanContext("1", "2"),
      decision: { action: "record", recordInputs: false, recordOutputs: true },
    });
  });
});

describe("readCurrentSessionTraceDecision", () => {
  it("reads the decision bound in the current worker context", async () => {
    const context = new ContextContainer();
    const decision = { action: "record", recordInputs: false, recordOutputs: true } as const;
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().setSession("session-1", {
        context: spanContext("1", "2"),
        decision,
        rootSessionId: "session-1",
      });
      expect(readCurrentSessionTraceDecision("session-1")).toEqual(decision);
    });
  });
});

describe("readActionTraceContext", () => {
  it("reads the invoking action span out of a serialized context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      context.set(SessionTraceSeedKey, {
        decision: { action: "record", recordInputs: true, recordOutputs: false },
        forwardedTracePolicy: {
          ceiling: { recordInputs: true, recordOutputs: true },
          originAudience: "private",
        },
        spanId: "2".repeat(16),
        traceFlags: 1,
        traceId: "1".repeat(32),
      });
      new ContextAgentTraceStateStore().setAction("action-1", {
        attemptIndex: 0,
        callId: "call-1",
        kind: "subagent-call",
        name: "researcher",
        parent: spanContext("1", "2"),
        rootSessionId: "session-1",
        sessionId: "session-1",
        spanId: "3".repeat(16),
        startTimeMs: 1_700_000_000_000,
        stepIndex: 0,
        turnId: "turn-1",
      });
    });
    const serialized = await serializeContext(context);

    expect(readActionTraceContext(serialized, "session-1", "turn-1", "call-1")).toEqual({
      decision: { action: "record", recordInputs: true, recordOutputs: false },
      forwardedTracePolicy: {
        ceiling: { recordInputs: true, recordOutputs: false },
        originAudience: "private",
      },
      isRemote: false,
      spanId: "3".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    });
    expect(readActionTraceContext(serialized, "session-1", "turn-1", "missing")).toBeUndefined();
  });

  it("propagates the stored session decision through an action context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      store.setSession("session-1", {
        context: spanContext("1", "2"),
        decision: { action: "record", recordInputs: true, recordOutputs: false },
        rootSessionId: "session-1",
      });
      store.setAction("action-1", {
        attemptIndex: 0,
        callId: "call-1",
        kind: "subagent-call",
        name: "researcher",
        parent: spanContext("1", "2"),
        rootSessionId: "session-1",
        sessionId: "session-1",
        spanId: "3".repeat(16),
        startTimeMs: 1_700_000_000_000,
        stepIndex: 0,
        turnId: "turn-1",
      });
    });

    expect(
      readActionTraceContext(await serializeContext(context), "session-1", "turn-1", "call-1"),
    ).toMatchObject({
      decision: { action: "record", recordInputs: true, recordOutputs: false },
    });
  });

  it("preserves a legacy forwarded ceiling when the stored session decision drops", async () => {
    const context = new ContextContainer();
    const forwardedTracePolicy = {
      ceiling: { recordInputs: false, recordOutputs: true },
      originAudience: "private" as const,
    };
    await contextStorage.run(context, () => {
      context.set(ParentTraceContextKey, {
        decision: { action: "drop" },
        forwardedTracePolicy,
        spanId: "2".repeat(16),
        traceFlags: 0,
        traceId: "1".repeat(32),
      });
      const store = new ContextAgentTraceStateStore();
      store.setSession("session-1", {
        context: spanContext("1", "2"),
        decision: { action: "drop" },
        rootSessionId: "session-1",
      });
      store.setAction("action-1", {
        attemptIndex: 0,
        callId: "call-1",
        kind: "subagent-call",
        name: "researcher",
        parent: { ...spanContext("1", "2"), traceFlags: 0 },
        rootSessionId: "session-1",
        sessionId: "session-1",
        spanId: "3".repeat(16),
        startTimeMs: 1,
        stepIndex: 0,
        turnId: "turn-1",
      });
    });

    expect(
      readActionTraceContext(await serializeContext(context), "session-1", "turn-1", "call-1"),
    ).toMatchObject({
      decision: { action: "drop" },
      forwardedTracePolicy,
      traceFlags: 0,
    });
  });
});

function spanContext(traceId: string, spanId: string) {
  return { spanId: spanId.repeat(16), traceFlags: 1, traceId: traceId.repeat(32) };
}
