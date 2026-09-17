import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type {
  InstrumentationAttemptScope,
  InstrumentationEvent,
  InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import {
  createInstrumentationHandleEvent,
  publishBackgroundTaskSettlements,
} from "#instrumentation/native-events.js";
import { rememberInstrumentationBackgroundTaskForCall } from "#instrumentation/state.js";
import { createActionResultEvent, createActionsRequestedEvent } from "#protocol/message.js";
import { preserveSerializedBackgroundTaskObservabilityState } from "#shared/serialized-observability-state.js";
import { deriveTaskId } from "#tasks/task-id.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "session-1:turn-1:0:0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

function recordingHooks(events: InstrumentationEvent[]): InstrumentationHooks {
  return {
    capturesContent: true,
    publish: async (event) => void events.push(event),
  };
}

async function emitBackgroundReceipt(
  context: ContextContainer,
  events: InstrumentationEvent[],
): Promise<string> {
  const taskId = deriveTaskId({
    callId: "workflow-1",
    parentSessionId: scope.sessionId,
    parentTurnId: scope.turnId,
  });
  await contextStorage.run(context, async () => {
    const handleEvent = createInstrumentationHandleEvent({
      getAttemptScope: () => scope,
      handleEvent: async () => {},
      hooks: recordingHooks(events),
      sessionId: scope.sessionId,
    })!;
    await handleEvent(
      createActionsRequestedEvent({
        actions: [
          {
            callId: "workflow-1",
            input: { report: "weekly" },
            kind: "workflow-tool-call",
            toolName: "publish",
            workflowId: "publish-workflow",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: scope.turnId,
      }),
    );
    await handleEvent(
      createActionResultEvent({
        result: {
          callId: "workflow-1",
          kind: "tool-result",
          output: { status: "working", taskId },
          toolName: "publish",
        },
        sequence: 0,
        stepIndex: 0,
        turnId: scope.turnId,
      }),
    );
    rememberInstrumentationBackgroundTaskForCall(scope.sessionId, "workflow-1", taskId);
  });
  return taskId;
}

describe("background task action instrumentation", () => {
  it("keeps the action open until its terminal task view arrives", async () => {
    const events: InstrumentationEvent[] = [];
    const context = new ContextContainer();
    const taskId = await emitBackgroundReceipt(context, events);
    expect(events.map((event) => event.type)).toEqual(["action.started"]);

    const restored = await deserializeContext(
      preserveSerializedBackgroundTaskObservabilityState({}, serializeContext(context), [
        { taskId },
      ]),
    );
    await contextStorage.run(restored, async () => {
      await publishBackgroundTaskSettlements({
        acceptedAtMs: 1_234,
        hooks: recordingHooks(events),
        views: [
          {
            lastOutput: { data: { reportId: "report-1" }, type: "result" },
            metadata: { kind: "tool", name: "publish" },
            status: "completed",
            taskId,
            usage: {
              cacheReadTokens: 3,
              cacheWriteTokens: 4,
              inputTokens: 10,
              outputTokens: 5,
            },
          },
        ],
      });
    });

    expect(events[1]).toEqual({
      acceptedAtMs: 1_234,
      idempotencyKey: actionIdempotencyKey(scope.sessionId, scope.turnId, "workflow-1"),
      outcome: "completed",
      output: { output: { reportId: "report-1" }, type: "result" },
      scope,
      type: "action.completed",
      usage: {
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
        inputTokens: 10,
        outputTokens: 5,
      },
    });
  });

  it.each([
    {
      error: "publish failed",
      errorCode: "BACKGROUND_TASK_FAILED",
      status: "failed" as const,
      view: {
        lastOutput: { data: "publish failed", type: "error" as const },
        metadata: { kind: "tool", name: "publish" },
        status: "failed" as const,
      },
    },
    {
      error: expect.any(Error),
      errorCode: "BACKGROUND_TASK_CANCELLED",
      status: "cancelled" as const,
      view: {
        metadata: { kind: "tool", name: "publish" },
        status: "cancelled" as const,
      },
    },
  ])("settles the action when its task is $status", async (input) => {
    const events: InstrumentationEvent[] = [];
    const context = new ContextContainer();
    const taskId = await emitBackgroundReceipt(context, events);
    await contextStorage.run(context, async () => {
      await publishBackgroundTaskSettlements({
        acceptedAtMs: 1_234,
        hooks: recordingHooks(events),
        views: [{ ...input.view, taskId }],
      });
    });

    expect(events[1]).toMatchObject({
      acceptedAtMs: 1_234,
      error: input.error,
      errorCode: input.errorCode,
      outcome: input.status,
      type: "action.failed",
    });
  });
});
