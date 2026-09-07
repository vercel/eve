import { afterEach, describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime.js";
import { prepareAgentInvocationTrace } from "#tracing/agent-invocation-coordinator.js";
import { settleAgentInvocationTrace } from "#tracing/agent-invocation-terminal.js";
import { AgentSpanIdGenerator, deriveAgentActionSpanId } from "#tracing/agent-span-id-generator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { deriveTaskId } from "#tasks/task-id.js";

const sessionState = {
  "eve.runtime.workflowToolRuns": [
    {
      callId: "workflow",
      hookToken: "workflow-hook",
      runId: "workflow-run",
      toolName: "coordinate",
    },
  ],
};

const RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
});

describe("agent invocation trace coordinator", () => {
  it("keeps parallel invocation identities and caller contexts independent", async () => {
    installRuntime();
    let serializedContext = await contextWithActionAnchor();

    const first = prepare(serializedContext, "workflow:first");
    serializedContext = first.serializedContext;
    const second = prepare(serializedContext, "workflow:second");
    serializedContext = second.serializedContext;

    expect(first.dispatch.parentTraceContext?.spanId).toBe(
      deriveAgentActionSpanId("session-1", "turn-1", "workflow:first"),
    );
    expect(second.dispatch.parentTraceContext?.spanId).toBe(
      deriveAgentActionSpanId("session-1", "turn-1", "workflow:second"),
    );

    const invocations = await readInvocations(serializedContext);
    expect(invocations).toEqual([
      expect.objectContaining({
        callId: "workflow:first",
        parentActionCallId: "workflow",
      }),
      expect.objectContaining({
        callId: "workflow:second",
        parentActionCallId: "workflow",
      }),
    ]);
  });

  it("replays one invocation with the same caller coordinates", async () => {
    installRuntime();
    const serializedContext = await contextWithActionAnchor();

    const first = prepare(serializedContext, "workflow:first");
    const replay = prepare(first.serializedContext, "workflow:first");

    expect(replay.dispatch).toEqual(first.dispatch);
    await expect(readInvocations(replay.serializedContext)).resolves.toHaveLength(1);
  });

  it("upgrades the built-in subagent action instead of creating a duplicate caller", async () => {
    installRuntime();
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      const action = outerAction();
      store.setAction("outer", action);
      store.setActionAnchor("outer", action);
    });
    const serializedContext = await serializeContext(context);

    const prepared = prepareAgentInvocationTrace({
      invocation: {
        callId: "workflow",
        kind: "subagent-call",
        name: "research",
      },
      ownerId: "workflow-run",
      serializedContext,
      sessionId: "session-1",
      sessionState,
      turnId: "turn-1",
    });
    const restored = await deserializeContext(prepared.serializedContext);
    await contextStorage.run(restored, () => {
      const store = new ContextAgentTraceStateStore();
      expect(store.getAction("outer")?.kind).toBe("subagent-call");
      expect(store.findActionAnchor("session-1", "turn-1", "workflow")?.kind).toBe("subagent-call");
      expect(store.findInvocations("session-1")).toHaveLength(0);
    });
  });

  it("uses the persisted action anchor after the live action is gone", async () => {
    installRuntime();
    const context = new ContextContainer();
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      const action = outerAction();
      store.setAction("outer", action);
      store.setActionAnchor("outer", action);
      store.deleteAction("outer");
    });

    const prepared = prepareAgentInvocationTrace({
      invocation: { callId: "workflow:background", kind: "subagent-call", name: "research" },
      ownerId: "background-task",
      serializedContext: serializeContext(context),
      sessionId: "session-1",
      taskId: deriveTaskId({
        callId: "workflow",
        parentSessionId: "session-1",
        parentTurnId: "turn-1",
      }),
      turnId: "later-turn",
    });

    expect(prepared.dispatch.parentTraceContext?.spanId).toBe(
      deriveAgentActionSpanId("session-1", "turn-1", "workflow:background"),
    );
    await expect(readInvocations(prepared.serializedContext)).resolves.toEqual([
      expect.objectContaining({
        callId: "workflow:background",
        parentActionCallId: "workflow",
      }),
    ]);
    const failed = prepared.fail({
      callId: "workflow:background",
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: "unreachable",
      subagentName: "research",
    });
    await expect(readInvocations(failed)).resolves.toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        terminal: expect.objectContaining({ outcome: "failed" }),
      }),
    ]);
  });

  it("does not infer an outer call from caller-chosen invocation IDs", async () => {
    const prepared = prepareAgentInvocationTrace({
      invocation: { callId: "workflow:unowned", kind: "subagent-call", name: "research" },
      ownerId: "other-run",
      serializedContext: await contextWithActionAnchor(),
      sessionId: "session-1",
      sessionState,
      turnId: "turn-1",
    });
    expect(prepared.dispatch.parentTraceContext).toBeUndefined();
    await expect(readInvocations(prepared.serializedContext)).resolves.toEqual([]);
  });

  it("records settlement on the matching invocation only", async () => {
    installRuntime();
    const first = prepare(await contextWithActionAnchor(), "workflow:first");
    const second = prepare(first.serializedContext, "workflow:second");
    const serializedContext = settleAgentInvocationTrace({
      result: {
        callId: "workflow:first",
        kind: "subagent-result",
        origin: "child",
        outcome: {
          kind: "parked",
          result: { kind: "succeeded", output: "done" },
          usageDelta: {
            cacheReadTokens: 1,
            cacheWriteTokens: 2,
            inputTokens: 3,
            outputTokens: 4,
          },
        },
        output: "done",
        subagentName: "research",
      },
      serializedContext: second.serializedContext,
      sessionId: "session-1",
    });

    const invocations = await readInvocations(serializedContext);
    expect(invocations.find((invocation) => invocation.callId === "workflow:first")).toMatchObject({
      terminal: {
        outcome: "completed",
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    });
    expect(
      invocations.find((invocation) => invocation.callId === "workflow:second")?.terminal,
    ).toBeUndefined();
  });
});

function prepare(serializedContext: Record<string, unknown>, callId: string) {
  return prepareAgentInvocationTrace({
    channelMetadata: { kind: "http", metadata: { audience: "private" } },
    invocation: {
      callId,
      kind: "subagent-call",
      name: "research",
    },
    ownerId: "workflow-run",
    serializedContext,
    sessionId: "session-1",
    sessionState,
    turnId: "turn-1",
  });
}

async function contextWithActionAnchor(): Promise<Record<string, unknown>> {
  const context = new ContextContainer();
  await contextStorage.run(context, () => {
    new ContextAgentTraceStateStore().setActionAnchor("outer", outerAction());
  });
  return await serializeContext(context);
}

async function readInvocations(serializedContext: Record<string, unknown>) {
  const context = await deserializeContext(serializedContext);
  return contextStorage.run(context, () =>
    new ContextAgentTraceStateStore().findInvocations("session-1", "turn-1", "workflow"),
  );
}

function outerAction() {
  return {
    attemptIndex: 0,
    callId: "workflow",
    channelAudience: "private" as const,
    kind: "tool-call" as const,
    name: "coordinate",
    parent: {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    },
    rootSessionId: "session-1",
    sessionId: "session-1",
    spanId: "3".repeat(16),
    startTimeMs: 1,
    stepIndex: 0,
    turnId: "turn-1",
  };
}

function installRuntime(): void {
  registerInstrumentationRuntime({
    forceFlush: async () => undefined,
    hooks: undefined as never,
    idGenerator: new AgentSpanIdGenerator(),
    otelSettings: undefined,
    prepareSessionTrace: async () => ({
      spanId: "4".repeat(16),
      traceFlags: 1,
      traceId: "5".repeat(32),
    }),
    runInContext: (_operation, callback) => callback(),
    shutdown: async () => undefined,
  });
}
