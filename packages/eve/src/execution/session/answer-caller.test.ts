import { describe, expect, it } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { attributeAnswers } from "#execution/session/answer-caller.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputRequest } from "#shared/input.js";

const approval: InputRequest = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: deploy",
  requestId: "approval-1",
};
const question: InputRequest = {
  action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "ask" },
  kind: "question",
  options: [{ id: "saturday", label: "Saturday" }],
  prompt: "Which day?",
  requestId: "question-1",
};
const bob: SessionAuthContext = {
  attributes: { team: "infra" },
  authenticator: "test",
  principalId: "bob",
  principalType: "user",
};
const state = appendPendingInputBatch({
  requests: [approval, question],
  responseMessages: [],
  session: {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
  },
}).state;
const approve = { optionId: "approve", requestId: approval.requestId };
const saturday = { optionId: "saturday", requestId: question.requestId };

describe("attributeAnswers", () => {
  it("carries the responder on approval answers and leaves other answers plain", () => {
    expect(
      attributeAnswers({
        responder: bob,
        state,
        stepInput: { inputResponses: [approve, saturday] },
      }),
    ).toEqual({
      attributedInputResponses: [{ auth: bob, response: approve }],
      inputResponses: [saturday],
    });
  });

  // Channels such as Discord deliver button presses with `auth: null`.
  it("attributes an approval sent with null auth to no one, never to the turn's caller", () => {
    expect(
      attributeAnswers({ responder: null, state, stepInput: { inputResponses: [approve] } }),
    ).toEqual({ attributedInputResponses: [{ auth: null, response: approve }] });
  });

  it("leaves a message or a stale answer to its sender", () => {
    expect(
      attributeAnswers({
        responder: bob,
        state,
        stepInput: { inputResponses: [approve], message: "Also do the other thing." },
      }),
    ).toBeUndefined();
    expect(
      attributeAnswers({
        responder: bob,
        state,
        stepInput: { inputResponses: [{ optionId: "approve", requestId: "answered-earlier" }] },
      }),
    ).toBeUndefined();
  });
});
