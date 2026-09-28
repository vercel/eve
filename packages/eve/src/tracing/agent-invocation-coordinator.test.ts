import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { prepareAgentInvocationTrace } from "#tracing/agent-invocation-coordinator.js";
import { settleAgentInvocationTrace } from "#tracing/agent-invocation-terminal.js";
import { deriveAgentActionSpanId } from "#tracing/agent-span-id-generator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { ConversationContext } from "#shared/conversation-context.js";

const outerKey = actionIdempotencyKey("session-1", "turn-1", "workflow");
const conversation: ConversationContext = {
  audience: "private",
  channel: { kind: "http" },
  environment: "production",
  principalType: "anonymous",
};

const sessionState = {
  "eve.workflowTool": {
    version: 4,
    runs: [
      {
        callId: "workflow",
        toolName: "coordinate",
        origin: { turnId: "turn-1", stepIndex: 0 },
        address: { runId: "workflow-run", hookToken: "workflow-hook" },
      },
    ],
  },
};

describe("agent invocation trace coordinator", () => {
  it("keeps parallel invocation identities and caller contexts independent", async () => {
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
    await expect(readActionAnchor(serializedContext)).resolves.toMatchObject({
      isWorkflowTool: true,
      workflowName: "coordinate",
    });
  });

  it("replays one invocation with the same caller coordinates", async () => {
    const serializedContext = await contextWithActionAnchor();

    const first = prepare(serializedContext, "workflow:first");
    const replay = prepare(first.serializedContext, "workflow:first");

    expect(replay.dispatch).toEqual(first.dispatch);
    await expect(readInvocations(replay.serializedContext)).resolves.toHaveLength(1);
    expect(prepare(serializedContext, "workflow:first").serializedContext).toEqual(
      first.serializedContext,
    );
  });

  it.each([0, 1])(
    "falls back to the turn when a nested caller anchor is missing (%s)",
    async (traceFlags) => {
      const context = new ContextContainer();
      const parent = { ...outerAction().parent, traceFlags };
      contextStorage.run(context, () => {
        new ContextAgentTraceStateStore().setTurn("session-1", "turn-1", {
          context: parent,
          rootSessionId: "session-1",
          sequence: 0,
          startTimeMs: 1,
        });
      });
      const prepared = prepare(serializeContext(context), "workflow:nested");
      expect(prepared.dispatch.parentTraceContext).toMatchObject(parent);
      await expect(readInvocations(prepared.serializedContext)).resolves.toEqual([]);
    },
  );

  it.each([
    ["subagent-call", true],
    ["subagent-call", false],
    ["remote-agent-call", true],
    ["remote-agent-call", false],
  ] as const)("caps %s context with or without a recorded caller (%s)", async (kind, recorded) => {
    const context = new ContextContainer();
    const action = outerAction();
    context.set(SessionTraceSeedKey, {
      ...action.parent,
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      forwardedTracePolicy: {
        originAudience: "public",
        ceiling: { recordInputs: true, recordOutputs: true },
      },
    });
    await contextStorage.run(context, () => {
      const store = new ContextAgentTraceStateStore();
      store.setTurn("session-1", "turn-1", {
        context: action.parent,
        rootSessionId: "session-1",
        sequence: 0,
        startTimeMs: 1,
      });
      if (recorded) {
        store.setAction(outerKey, action);
        store.setActionAnchor(outerKey, action);
      }
    });
    const serializedContext = await serializeContext(context);

    const prepared = prepareAgentInvocationTrace({
      conversation,
      invocation: {
        callId: "workflow",
        kind,
        name: "research",
      },
      ownerId: "workflow-run",
      startTimeMs: 2,
      serializedContext,
      sessionId: "session-1",
      sessionState,
      turnId: "turn-1",
    });
    expect(prepared.dispatch.parentTraceContext).toMatchObject({
      ...action.parent,
      spanId: recorded ? action.spanId : action.parent.spanId,
      decision: { action: "record", recordInputs: false, recordOutputs: false },
    });
    expect(prepared.dispatch.originAudience).toBe("public");
    const restored = await deserializeContext(prepared.serializedContext);
    await contextStorage.run(restored, () => {
      const store = new ContextAgentTraceStateStore();
      expect(store.getAction(outerKey)?.kind).toBe(recorded ? kind : undefined);
      expect(store.findActionAnchor("session-1", "turn-1", "workflow")?.kind).toBe(
        recorded ? kind : undefined,
      );
      expect(store.findActionAnchor("session-1", "turn-1", "workflow")?.isWorkflowTool).toBe(
        undefined,
      );
      expect(store.findActionAnchor("session-1", "turn-1", "workflow")?.workflowName).toBe(
        undefined,
      );
      expect(store.findInvocations("session-1")).toHaveLength(0);
    });
  });

  it("does not infer an outer call from caller-chosen invocation IDs", async () => {
    const prepared = prepareAgentInvocationTrace({
      invocation: { callId: "workflow:unowned", kind: "subagent-call", name: "research" },
      ownerId: "other-run",
      startTimeMs: 2,
      serializedContext: await contextWithActionAnchor(),
      sessionId: "session-1",
      sessionState,
      turnId: "turn-1",
    });
    expect(prepared.dispatch.parentTraceContext).toBeUndefined();
    await expect(readInvocations(prepared.serializedContext)).resolves.toEqual([]);
  });

  it("records settlement on the matching invocation only", async () => {
    const first = prepare(await contextWithActionAnchor(), "workflow:first");
    const second = prepare(first.serializedContext, "workflow:second");
    const serializedContext = settleAgentInvocationTrace({
      acceptedAtMs: 3,
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
        acceptedAtMs: 3,
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
    conversation,
    invocation: {
      callId,
      kind: "subagent-call",
      name: "research",
    },
    ownerId: "workflow-run",
    startTimeMs: 2,
    serializedContext,
    sessionId: "session-1",
    sessionState,
    turnId: "turn-1",
  });
}

async function contextWithActionAnchor(): Promise<Record<string, unknown>> {
  const context = new ContextContainer();
  await contextStorage.run(context, () => {
    new ContextAgentTraceStateStore().setActionAnchor(outerKey, outerAction());
  });
  return await serializeContext(context);
}

async function readInvocations(serializedContext: Record<string, unknown>) {
  const context = await deserializeContext(serializedContext);
  return contextStorage.run(context, () =>
    new ContextAgentTraceStateStore().findInvocations("session-1", "turn-1", "workflow"),
  );
}

async function readActionAnchor(serializedContext: Record<string, unknown>) {
  const context = await deserializeContext(serializedContext);
  return contextStorage.run(context, () =>
    new ContextAgentTraceStateStore().findActionAnchor("session-1", "turn-1", "workflow"),
  );
}

function outerAction() {
  return {
    attemptIndex: 0,
    callId: "workflow",
    channelAudience: "private" as const,
    isWorkflowTool: true,
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
