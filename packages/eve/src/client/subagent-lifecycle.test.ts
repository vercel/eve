import { describe, expect, it } from "vitest";

import { subagentParentTransition } from "#client/subagent-lifecycle.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { createActionResultEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

function transition(event: UnstampedMessageStreamEvent) {
  return subagentParentTransition(stampTestEvent(event, 0));
}

describe("subagent parent transitions", () => {
  it("distinguishes a working receipt from completion", () => {
    expect(
      transition(
        createActionResultEvent({
          result: {
            kind: "subagent-result",
            callId: "call-1",
            subagentName: "research",
            origin: "child",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "working" },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            },
            output: { status: "working", taskId: "task-1", agentId: "research" },
          },
          turnId: "turn-1",
          stepIndex: 0,
          sequence: 0,
        }),
      ),
    ).toEqual({ type: "background", callId: "call-1" });
    expect(
      transition({
        type: "subagent.completed",
        data: { callId: "call-1", subagentName: "research", output: "done" },
      } as UnstampedMessageStreamEvent),
    ).toEqual({ type: "completed", callId: "call-1" });
  });

  it("does not treat a failed receipt as background work", () => {
    const data = {
      result: {
        kind: "tool-result" as const,
        callId: "call-1",
        toolName: "search",
        output: { status: "working", taskId: "task-1", agentId: "research" },
      },
      turnId: "turn-1",
      stepIndex: 0,
      sequence: 0,
    };
    expect(
      transition({
        type: "action.result",
        data: { ...data, status: "completed" },
      } as UnstampedMessageStreamEvent),
    ).toEqual({ type: "background", callId: "call-1" });
    expect(
      transition({
        type: "action.result",
        data: { ...data, status: "failed" },
      } as UnstampedMessageStreamEvent),
    ).toBeUndefined();
  });

  it("keeps legacy background markers provisional and cancellation turn-scoped", () => {
    expect(
      transition({
        type: "subagent.completed",
        data: {
          callId: "call-1",
          subagentName: "research",
          output: "working",
          backgroundTask: { taskId: "task-1", status: "working" },
        },
      } as UnstampedMessageStreamEvent),
    ).toEqual({ type: "background", callId: "call-1" });
    expect(
      transition({
        type: "turn.cancelled",
        data: { turnId: "turn-1" },
      } as UnstampedMessageStreamEvent),
    ).toEqual({ type: "turn-cancelled", turnId: "turn-1" });
  });
});
