import { describe, expect, it } from "vitest";

import {
  createInputRequestedEvent,
  createInputResponseActionResultEvent,
  createInputTerminalActionResultEvent,
  createMessageCompletedEvent,
} from "#public/testing/index.js";

const request = {
  action: {
    callId: "question-call",
    input: { prompt: "Choose" },
    kind: "tool-call" as const,
    toolName: "ask_question",
  },
  prompt: "Choose",
  requestId: "question-request",
};

describe("eve/testing event builders", () => {
  it("builds request and correlated settlement action results", () => {
    const requested = createInputRequestedEvent({
      requests: [request],
      sequence: 2,
      stepIndex: 1,
      turnId: "turn-2",
    });
    const responded = createInputResponseActionResultEvent({
      request,
      response: { requestId: request.requestId, text: "Blue" },
      sequence: 2,
      stepIndex: 1,
      turnId: "turn-2",
    });
    const ignored = createInputTerminalActionResultEvent({
      outcome: "ignored",
      request,
      sequence: 2,
      stepIndex: 1,
      turnId: "turn-2",
    });

    expect(requested.data.requests[0]?.action.callId).toBe("question-call");
    expect(responded).toMatchObject({
      data: {
        inputSettlement: {
          outcome: "responded",
          response: { requestId: "question-request", text: "Blue" },
        },
        result: { callId: "question-call" },
      },
      type: "action.result",
    });
    expect(ignored).toMatchObject({
      data: {
        inputSettlement: { outcome: "ignored", requestId: "question-request" },
        result: { callId: "question-call" },
      },
      type: "action.result",
    });
  });

  it("requires the emitter-owned assistant block occurrence", () => {
    expect(
      createMessageCompletedEvent({
        blockIndex: 3,
        message: "Repeated",
        sequence: 2,
        stepIndex: 1,
        turnId: "turn-2",
      }),
    ).toMatchObject({
      data: {
        blockIndex: 3,
        message: "Repeated",
        sequence: 2,
        stepIndex: 1,
        turnId: "turn-2",
      },
      type: "message.completed",
    });
  });
});
