import { describe, expect, it } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { attributeApprovalAnswers } from "#execution/session/approval-response-caller.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputRequest } from "#shared/input.js";

const approval: InputRequest = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: deploy",
  requestId: "approval-1",
};
const bob: SessionAuthContext = {
  attributes: { team: "infra" },
  authenticator: "test",
  principalId: "bob",
  principalType: "user",
};
const state = appendPendingInputBatch({
  requests: [approval],
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

describe("attributeApprovalAnswers", () => {
  it("carries the responder on an approval answer", () => {
    expect(
      attributeApprovalAnswers({ responder: bob, state, stepInput: { inputResponses: [approve] } }),
    ).toEqual({ attributedInputResponses: [{ auth: bob, response: approve }] });
  });

  it("attributes an unauthenticated answer to no one, never to the turn's caller", () => {
    expect(
      attributeApprovalAnswers({
        responder: null,
        state,
        stepInput: { inputResponses: [approve] },
      }),
    ).toEqual({ attributedInputResponses: [{ auth: null, response: approve }] });
  });

  it("leaves a message or an answer to anything else to its sender", () => {
    expect(
      attributeApprovalAnswers({
        responder: bob,
        state,
        stepInput: { inputResponses: [approve], message: "Also do the other thing." },
      }),
    ).toBeUndefined();
    expect(
      attributeApprovalAnswers({
        responder: bob,
        state,
        stepInput: { inputResponses: [{ optionId: "continue", requestId: "session-limit-1" }] },
      }),
    ).toBeUndefined();
  });
});
