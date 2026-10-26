import { describe, expect, it } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { attributeAnswers } from "#execution/session/answer-caller.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { foldSession, initialSessionProjection } from "#protocol/session-projection.js";
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
const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
const state = {
  [SESSION_PROJECTION_STATE_KEY]: [
    { type: "turn.started", data: { sequence: 0, turnId: "turn_0" } },
    { type: "input.requested", data: { ...at, requests: [approval, question] } },
  ].reduce(foldSession, initialSessionProjection()),
};
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

  const alice: SessionAuthContext = { ...bob, principalId: "alice" };
  const stale = { optionId: "approve", requestId: "answered-earlier" };

  it("attributes another person's live approval to them and drops their stale answer", () => {
    expect(
      attributeAnswers({
        owner: alice,
        responder: bob,
        state,
        stepInput: { inputResponses: [stale, approve] },
      }),
    ).toEqual({ attributedInputResponses: [{ auth: bob, response: approve }] });
    expect(
      attributeAnswers({
        owner: alice,
        responder: bob,
        state,
        stepInput: { inputResponses: [stale] },
      }),
    ).toEqual({ attributedInputResponses: [] });
  });

  it("keeps the turn's own principal's stale answer for the turn to read", () => {
    expect(
      attributeAnswers({
        owner: bob,
        responder: bob,
        state,
        stepInput: { inputResponses: [stale, approve] },
      }),
    ).toEqual({
      attributedInputResponses: [{ auth: bob, response: approve }],
      inputResponses: [stale],
    });
  });
});
