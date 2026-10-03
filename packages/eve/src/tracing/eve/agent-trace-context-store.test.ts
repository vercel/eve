import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  ContextAgentTraceStateStore,
  preserveSerializedAgentTraceState,
  readActionTraceContext,
  readTurnTraceContext,
} from "#tracing/eve/agent-trace-context-store.js";

describe("ContextAgentTraceStateStore", () => {
  it("restores serializable session and turn context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      store.set("session", "session-1", {
        agentName: "weather",
        channelType: "http",
        context: spanContext("1", "2"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
      });
      store.set("turn", JSON.stringify(["session-1", "turn-1"]), {
        channelDelivery: {
          channelKind: "channel:slack",
          channelName: "slack",
          deliveryId: "delivery-1",
          inputAttribute: '{"message":"hello"}',
          requestId: "request-1",
          requestTraceContext: { ...spanContext("5", "6"), isRemote: true },
        },
        context: spanContext("1", "3"),
        currentPrincipal: { id: "user-123", type: "user" },
        initiatorPrincipal: { type: "none" },
        caller: { ...spanContext("4", "2"), isRemote: true },
        rootSessionId: "session-1",
        traceSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1_700_000_000_000,
        subagentName: "researcher",
        snapshot: {
          terminal: { outcome: "failed", error: { message: "failed" } },
          usage: { inputTokens: 12, outputTokens: 4 },
        },
      });
    });

    const serialized = await serializeContext(context);
    const restored = await deserializeContext(serialized);
    await contextStorage.run(restored, () => {
      const store = new ContextAgentTraceStateStore();
      expect(store.get("session", "session-1")).toMatchObject({
        channelType: "http",
        context: spanContext("1", "2"),
      });
      expect(store.get("turn", JSON.stringify(["session-1", "turn-1"]))?.context).toEqual(
        spanContext("1", "3"),
      );
      expect(store.get("turn", JSON.stringify(["session-1", "turn-1"]))).toMatchObject({
        channelDelivery: {
          channelKind: "channel:slack",
          channelName: "slack",
          deliveryId: "delivery-1",
          inputAttribute: '{"message":"hello"}',
          requestId: "request-1",
          requestTraceContext: { ...spanContext("5", "6"), isRemote: true },
        },
        currentPrincipal: { id: "user-123", type: "user" },
        initiatorPrincipal: { type: "none" },
        snapshot: {
          terminal: { outcome: "failed", error: { message: "failed" } },
          usage: { inputTokens: 12, outputTokens: 4 },
        },
        caller: { ...spanContext("4", "2"), isRemote: true },
        startTimeMs: 1_700_000_000_000,
        subagentName: "researcher",
      });
      expect(
        store.get("turn", JSON.stringify(["session-1", "turn-1"]))?.initiatorPrincipal,
      ).toStrictEqual({
        type: "none",
      });
      expect(
        JSON.stringify(store.get("turn", JSON.stringify(["session-1", "turn-1"]))),
      ).not.toContain("attributes");
    });
  });

  it("removes terminal state", () => {
    contextStorage.run(new ContextContainer(), () => {
      const store = new ContextAgentTraceStateStore();
      store.set("session", "session-1", {
        context: spanContext("1", "2"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
      });
      store.set("turn", JSON.stringify(["session-1", "turn-1"]), {
        context: spanContext("1", "3"),
        caller: spanContext("4", "2"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1_700_000_000_000,
      });

      store.delete("turn", JSON.stringify(["session-1", "turn-1"]));
      store.delete("session", "session-1");

      expect(store.get("turn", JSON.stringify(["session-1", "turn-1"]))).toBeUndefined();
      expect(store.get("session", "session-1")).toBeUndefined();
    });
  });

  it("composes atomic turn updates without recreating deleted turns", () => {
    contextStorage.run(new ContextContainer(), () => {
      const store = new ContextAgentTraceStateStore();
      store.set("turn", JSON.stringify(["session-1", "turn-1"]), {
        context: spanContext("1", "3"),
        caller: spanContext("4", "2"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1_700_000_000_000,
      });

      store.update("turn", JSON.stringify(["session-1", "turn-1"]), (turn) => ({
        ...turn,
        snapshot: { usage: { inputTokens: 12, outputTokens: 4 } },
      }));
      store.update("turn", JSON.stringify(["session-1", "turn-1"]), (turn) => ({
        ...turn,
        channelDelivery: { channelKind: "http", channelName: "http", deliveryId: "delivery" },
      }));

      expect(store.get("turn", JSON.stringify(["session-1", "turn-1"]))).toMatchObject({
        snapshot: { usage: { inputTokens: 12, outputTokens: 4 } },
        channelDelivery: { deliveryId: "delivery" },
      });
      store.delete("turn", JSON.stringify(["session-1", "turn-1"]));
      store.update("turn", JSON.stringify(["session-1", "turn-1"]), (turn) => ({
        ...turn,
        snapshot: { usage: { inputTokens: 99 } },
      }));
      expect(store.get("turn", JSON.stringify(["session-1", "turn-1"]))).toBeUndefined();
    });
  });

  it("preserves only trace state from an interrupted context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().set("session", "session-1", {
        context: spanContext("1", "2"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
      });
    });

    const interrupted = await serializeContext(context);
    const preserved = preserveSerializedAgentTraceState({ authored: "original" }, interrupted);

    expect(preserved.authored).toBe("original");
    expect(preserved["eve.harness.agentTrace"]).toBeDefined();
  });
});

describe("readTurnTraceContext", () => {
  it("reads one active turn's trace context out of a serialized context", async () => {
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
      new ContextAgentTraceStateStore().set("session", "session-1", {
        context: spanContext("1", "2"),
        decision: { action: "record", recordInputs: true, recordOutputs: false },
        rootSessionId: "session-1",
        traceSessionId: "session-1",
      });
      new ContextAgentTraceStateStore().set("turn", JSON.stringify(["session-1", "turn-1"]), {
        context: spanContext("3", "4"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1,
      });
    });
    const serialized = await serializeContext(context);

    expect(readTurnTraceContext(serialized, "session-1", "turn-1")).toEqual({
      ...spanContext("3", "4"),
      decision: { action: "record", recordInputs: true, recordOutputs: false },
      forwardedTracePolicy: {
        ceiling: { recordInputs: true, recordOutputs: false },
        originAudience: "private",
      },
    });
    expect(readTurnTraceContext(serialized, "session-1", "turn-2")).toBeUndefined();
    expect(readTurnTraceContext({}, "session-1", "turn-1")).toBeUndefined();
  });

  it("preserves a stored decision when the context has no trace seed", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      store.set("session", "session-1", {
        context: spanContext("1", "2"),
        decision: { action: "record", recordInputs: false, recordOutputs: true },
        rootSessionId: "session-1",
        traceSessionId: "session-1",
      });
      store.set("turn", JSON.stringify(["session-1", "turn-1"]), {
        context: spanContext("3", "4"),
        rootSessionId: "session-1",
        traceSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1,
      });
    });

    expect(readTurnTraceContext(await serializeContext(context), "session-1", "turn-1")).toEqual({
      ...spanContext("3", "4"),
      decision: { action: "record", recordInputs: false, recordOutputs: true },
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
      new ContextAgentTraceStateStore().set("action", "action:session-1:turn-1:call-1", {
        callId: "call-1",
        snapshot: actionSnapshot(),
        sessionId: "session-1",
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
      store.set("session", "session-1", {
        context: spanContext("1", "2"),
        decision: { action: "record", recordInputs: true, recordOutputs: false },
        rootSessionId: "session-1",
        traceSessionId: "session-1",
      });
      store.set("action", "action:session-1:turn-1:call-1", {
        callId: "call-1",
        snapshot: actionSnapshot(),
        sessionId: "session-1",
        turnId: "turn-1",
      });
    });

    expect(
      readActionTraceContext(await serializeContext(context), "session-1", "turn-1", "call-1"),
    ).toMatchObject({
      decision: { action: "record", recordInputs: true, recordOutputs: false },
    });
  });
});

function spanContext(traceId: string, spanId: string) {
  return { spanId: spanId.repeat(16), traceFlags: 1, traceId: traceId.repeat(32) };
}
function actionSnapshot() {
  return {
    version: 1,
    key: "action",
    identity: { conversationId: "session-1", runId: "session-1", turnId: "turn-1" },
    data: { type: "action", options: { callId: "call-1", name: "researcher" } },
    capture: { emit: true, recordInputs: true, recordOutputs: false },
    reference: spanContext("1", "3"),
    startTimeMs: 1,
  };
}
