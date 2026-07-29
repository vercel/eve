import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  ContextAgentTraceStateStore,
  preserveSerializedAgentTraceState,
} from "#harness/agent-trace-context-store.js";

describe("ContextAgentTraceStateStore", () => {
  it("restores serializable session and turn context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      store.setSession("session-1", {
        agentName: "weather",
        context: spanContext("1", "2"),
        pendingStarted: false,
        rootSessionId: "session-1",
      });
      store.setTurn("session-1", "turn-1", {
        context: spanContext("1", "3"),
        rootSessionId: "session-1",
        sequence: 0,
        terminal: { error: new Error("failed"), type: "turn.failed" },
      });
    });

    const serialized = await serializeContext(context);
    const restored = await deserializeContext(serialized);
    await contextStorage.run(restored, () => {
      const store = new ContextAgentTraceStateStore();
      expect(store.getSession("session-1")?.context).toEqual(spanContext("1", "2"));
      expect(store.getTurn("session-1", "turn-1")?.context).toEqual(spanContext("1", "3"));
      expect(store.getTurn("session-1", "turn-1")?.terminal?.error).toMatchObject({
        message: "failed",
      });
    });
  });

  it("removes terminal state", () => {
    contextStorage.run(new ContextContainer(), () => {
      const store = new ContextAgentTraceStateStore();
      store.setSession("session-1", {
        context: spanContext("1", "2"),
        pendingStarted: true,
        rootSessionId: "session-1",
      });
      store.setTurn("session-1", "turn-1", {
        context: spanContext("1", "3"),
        rootSessionId: "session-1",
        sequence: 0,
      });

      store.deleteTurn("session-1", "turn-1");
      store.deleteSession("session-1");

      expect(store.getTurn("session-1", "turn-1")).toBeUndefined();
      expect(store.getSession("session-1")).toBeUndefined();
    });
  });

  it("preserves only trace state from an interrupted context", async () => {
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      new ContextAgentTraceStateStore().setSession("session-1", {
        context: spanContext("1", "2"),
        pendingStarted: true,
        rootSessionId: "session-1",
      });
    });

    const interrupted = await serializeContext(context);
    const preserved = preserveSerializedAgentTraceState({ authored: "original" }, interrupted);

    expect(preserved.authored).toBe("original");
    expect(preserved["eve.harness.agentTrace"]).toBeDefined();
  });
});

function spanContext(traceId: string, spanId: string) {
  return { spanId: spanId.repeat(16), traceFlags: 1, traceId: traceId.repeat(32) };
}
