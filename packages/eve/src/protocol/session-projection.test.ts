import { describe, expect, it } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  callStatus,
  foldSession,
  initialSessionProjection,
  pruneSessionProjection,
  turnCoordinates,
} from "#protocol/session-projection.js";

const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
const fold = (events: readonly UnstampedMessageStreamEvent[]) =>
  events.reduce(foldSession, initialSessionProjection());
const turnStarted: UnstampedMessageStreamEvent = {
  type: "turn.started",
  data: { sequence: 0, turnId: "turn_0" },
};
const toolCall = (callId: string, toolName = "deploy"): UnstampedMessageStreamEvent => ({
  type: "actions.requested",
  data: { ...at, actions: [{ callId, input: {}, kind: "tool-call", toolName }] },
});

describe("foldSession", () => {
  it("reads a failed subagent's outcome from task.settled, not its receipt", () => {
    const projection = fold([
      turnStarted,
      toolCall("call_1", "researcher"),
      {
        type: "task.started",
        data: {
          callId: "call_1",
          kind: "agent",
          name: "researcher",
          taskId: "t1",
          turnId: "turn_0",
        },
      },
      {
        type: "action.result",
        data: {
          ...at,
          result: {
            callId: "call_1",
            kind: "tool-result",
            output: "started",
            toolName: "researcher",
          },
          status: "completed",
        },
      } as UnstampedMessageStreamEvent,
      { type: "turn.completed", data: { sequence: 0, turnId: "turn_0" } },
    ]);
    expect(callStatus(projection, "call_1")).toBe("running");
    const settled = foldSession(projection, {
      type: "task.settled",
      data: {
        callId: "call_1",
        error: { message: "boom" },
        status: "failed",
        taskId: "t1",
        turnId: "turn_0",
      },
    });
    expect(callStatus(settled, "call_1")).toBe("failed");
  });

  it("reads a policy's denial as rejected", () => {
    const projection = fold([
      turnStarted,
      toolCall("call_1"),
      {
        type: "action.result",
        data: {
          ...at,
          error: { code: "TOOL_EXECUTION_DENIED", message: "denied" },
          result: {
            callId: "call_1",
            isError: true,
            kind: "tool-result",
            output: "",
            toolName: "deploy",
          },
          status: "failed",
        },
      } as UnstampedMessageStreamEvent,
    ]);
    expect(callStatus(projection, "call_1")).toBe("rejected");
  });

  it("reads a call its cancelled turn left without a result as interrupted", () => {
    const projection = fold([
      turnStarted,
      toolCall("call_1"),
      { type: "turn.cancelled", data: { sequence: 0, turnId: "turn_0" } },
    ]);
    expect(callStatus(projection, "call_1")).toBe("interrupted");
    expect(turnCoordinates(projection)).toEqual({ sequence: 1, stepIndex: 0, turnId: "turn_1" });
  });

  it("reads a responder's declined approval as denied, not withdrawn", () => {
    const request = {
      action: { callId: "call_1", input: {}, kind: "tool-call" as const, toolName: "deploy" },
      kind: "tool-approval" as const,
      prompt: "Deploy?",
      requestId: "req_1",
    };
    const projection = fold([
      turnStarted,
      toolCall("call_1"),
      { type: "input.requested", data: { ...at, requests: [request] } },
      {
        type: "approval.settled",
        data: { ...at, outcome: "cancelled", requestId: "req_1", responderPrincipalId: "bob" },
      },
      {
        type: "input.resolved",
        data: {
          ...at,
          resolutions: [{ kind: "tool-approval", outcome: "denied", requestId: "req_1" }],
        },
      },
    ]);
    expect(projection.inputs.req_1).toMatchObject({ outcome: "denied", status: "settled" });
    expect(callStatus(projection, "call_1")).toBe("rejected");
  });

  it("names a call whose result arrives unannounced", () => {
    const projection = fold([
      turnStarted,
      {
        type: "action.result",
        data: {
          ...at,
          result: { callId: "call_1", kind: "tool-result", output: "done", toolName: "deploy" },
          status: "completed",
        },
      },
    ]);
    expect(projection.calls.call_1).toMatchObject({ name: "deploy", status: "completed" });
  });

  it("records the calls a sign-in stopped", () => {
    const projection = fold([
      turnStarted,
      toolCall("call_1"),
      {
        type: "authorization.required",
        data: { ...at, callIds: ["call_1"], description: "Linear", name: "linear" },
      },
    ]);
    expect(projection.authorizations.linear).toMatchObject({
      callIds: ["call_1"],
      status: "required",
    });
  });

  it("tracks an approval from request to decision", () => {
    const request = {
      action: { callId: "call_1", input: {}, kind: "tool-call" as const, toolName: "deploy" },
      kind: "tool-approval" as const,
      prompt: "Deploy?",
      requestId: "req_1",
    };
    const asked = fold([
      turnStarted,
      toolCall("call_1"),
      { type: "input.requested", data: { ...at, requests: [request] } },
      { type: "turn.completed", data: { sequence: 0, turnId: "turn_0" } },
      {
        type: "session.waiting",
        data: { continuationToken: "s", wait: "next-user-message" },
      },
    ]);
    expect(callStatus(asked, "call_1")).toBe("awaiting-input");
    const denied = foldSession(asked, {
      type: "input.resolved",
      data: {
        ...at,
        resolutions: [{ kind: "tool-approval", outcome: "denied", requestId: "req_1" }],
      },
    });
    expect(callStatus(denied, "call_1")).toBe("rejected");
    expect(pruneSessionProjection(denied)).toMatchObject({ calls: {}, inputs: {}, turns: {} });
  });
});
