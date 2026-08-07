import { describe, expect, it } from "vitest";

import { TASK_AUTHORIZATION_REQUEST_ID } from "#tasks/types.js";
import { translateTaskInboundPayload } from "#tasks/wire.js";

const ZERO_USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };
const USAGE = { cacheReadTokens: 1, cacheWriteTokens: 2, inputTokens: 300, outputTokens: 40 };

describe("translateTaskInboundPayload", () => {
  it("passes explicit task commands through", () => {
    expect(
      translateTaskInboundPayload({ command: { kind: "cancel" }, kind: "task-command" }),
    ).toEqual({ kind: "cancel" });
  });

  it("completes on a succeeded child turn outcome, parked or terminal", () => {
    for (const kind of ["parked", "terminal"] as const) {
      expect(
        translateTaskInboundPayload({
          kind: "runtime-action-result",
          results: [
            {
              outcome: {
                kind,
                result: { kind: "succeeded", output: "answer" },
                usageDelta: ZERO_USAGE,
              },
              output: "answer",
            },
          ],
        }),
      ).toEqual({ data: "answer", kind: "complete", lifecycle: kind, usage: ZERO_USAGE });
    }
  });

  it("retains nonzero child usage on complete, fail, and cancel commands", () => {
    const outcomes = [
      {
        expected: { data: "done", kind: "complete" },
        result: { kind: "succeeded", output: "done" },
      },
      { expected: { data: "done", kind: "fail" }, result: { error: "boom", kind: "failed" } },
      { expected: { kind: "cancel" }, result: { kind: "cancelled" } },
    ] as const;
    for (const { expected, result } of outcomes) {
      expect(
        translateTaskInboundPayload({
          kind: "runtime-action-result",
          results: [{ outcome: { kind: "terminal", result, usageDelta: USAGE }, output: "done" }],
        }),
      ).toEqual({ ...expected, lifecycle: "terminal", usage: USAGE });
    }
  });

  it("drops malformed usage rather than failing the transition command", () => {
    for (const usageDelta of [null, "n/a", { inputTokens: -1 }, { inputTokens: 1 }]) {
      expect(
        translateTaskInboundPayload({
          kind: "runtime-action-result",
          results: [
            {
              outcome: {
                kind: "terminal",
                result: { kind: "succeeded", output: "ok" },
                usageDelta,
              },
              output: "ok",
            },
          ],
        }),
      ).toEqual({ data: "ok", kind: "complete", lifecycle: "terminal" });
    }
  });

  it("fails on a failed outcome and cancels on a cancelled outcome", () => {
    expect(
      translateTaskInboundPayload({
        kind: "runtime-action-result",
        results: [
          {
            outcome: {
              kind: "terminal",
              result: { error: { message: "boom" }, kind: "failed" },
              usageDelta: ZERO_USAGE,
            },
            output: { message: "boom" },
          },
        ],
      }),
    ).toEqual({
      data: { message: "boom" },
      kind: "fail",
      lifecycle: "terminal",
      usage: ZERO_USAGE,
    });

    expect(
      translateTaskInboundPayload({
        kind: "runtime-action-result",
        results: [
          {
            outcome: { kind: "terminal", result: { kind: "cancelled" }, usageDelta: ZERO_USAGE },
            output: null,
          },
        ],
      }),
    ).toEqual({ kind: "cancel", lifecycle: "terminal", usage: ZERO_USAGE });
  });

  it("ignores results without an explicit lifecycle outcome", () => {
    expect(
      translateTaskInboundPayload({
        kind: "runtime-action-result",
        results: [{ isError: true, output: "broken" }],
      }),
    ).toBeUndefined();
    expect(
      translateTaskInboundPayload({ kind: "runtime-action-result", results: [{ output: "ok" }] }),
    ).toBeUndefined();
  });

  it("ignores empty result payloads", () => {
    expect(
      translateTaskInboundPayload({ kind: "runtime-action-result", results: [] }),
    ).toBeUndefined();
  });

  it("marks the task input_required on a forwarded HITL batch", () => {
    expect(
      translateTaskInboundPayload({
        callId: "call-1",
        childContinuationToken: "child-token",
        childSessionId: "child-session",
        event: {
          requests: [{ prompt: "Which region?" }],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
        kind: "subagent-input-request",
        subagentName: "research",
      }),
    ).toEqual({ inputRequests: [{ prompt: "Which region?" }], kind: "require-input" });
  });

  it("blocks authorization under a reserved id that only its completion clears", () => {
    expect(
      translateTaskInboundPayload({
        callId: "call-1",
        childSessionId: "child-session",
        event: {
          data: {
            description: "Authorize GitHub",
            name: "github",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn-1",
          },
          type: "authorization.required",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      }),
    ).toEqual({
      inputRequests: [{ blockedOn: "authorization", requestId: TASK_AUTHORIZATION_REQUEST_ID }],
      kind: "require-input",
    });
    expect(
      translateTaskInboundPayload({
        callId: "call-1",
        childSessionId: "child-session",
        event: {
          data: {
            name: "github",
            outcome: "authorized",
            sequence: 2,
            stepIndex: 2,
            turnId: "turn-1",
          },
          type: "authorization.completed",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      }),
    ).toEqual({ kind: "answered", requestIds: [TASK_AUTHORIZATION_REQUEST_ID] });
  });

  it("leaves answered input to the run, which must deliver before recording it", () => {
    expect(
      translateTaskInboundPayload({
        childContinuationToken: "child-token",
        inputResponses: [{ requestId: "req-1", text: "west" }],
        kind: "task-answer-input",
        taskId: "task-1",
      }),
    ).toBeUndefined();
  });
});
