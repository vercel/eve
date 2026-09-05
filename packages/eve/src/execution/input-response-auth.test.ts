import { describe, expect, it } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { attributeInputResponses } from "#execution/input-response-auth.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const caller: SessionAuthContext = {
  authenticator: "test",
  principalType: "user",
  principalId: "user-b",
  attributes: {},
};
const responder: SessionAuthContext = {
  authenticator: "oidc",
  principalType: "service",
  principalId: "operator",
  attributes: {},
};
const session: HarnessSession = {
  agent: { modelReference: { id: "test" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  history: [],
  sessionId: "test",
  continuationToken: "test",
};
function state(kind: InputRequest["kind"]) {
  return appendPendingInputBatch({
    session,
    responseMessages: [],
    requests: [
      {
        kind,
        requestId: "r",
        prompt: "Continue?",
        action: { kind: "tool-call", callId: "c", toolName: "test", input: {} },
      },
    ],
  }).state;
}
const response = { requestId: "r", optionId: "approve" };

describe("input response caller attribution", () => {
  for (const kind of ["tool-approval", "session-limit"] as const) {
    it(`retains the suspended caller for ${kind} and keeps responder attribution`, () => {
      const result = attributeInputResponses({
        caller,
        responder,
        state: state(kind),
        stepInput: { inputResponses: [response] },
      });
      expect(result.caller).toEqual(caller);
      if (kind === "tool-approval")
        expect(result.stepInput).toEqual({
          attributedInputResponses: [{ auth: responder, response }],
        });
      else expect(result.stepInput).toEqual({ inputResponses: [response] });
    });
  }
  it("does not upgrade stale responses, question answers, or messages to the prior user", () => {
    for (const stepInput of [
      { inputResponses: [{ ...response, requestId: "stale" }] },
      { message: "new task" },
      { message: "new task", inputResponses: [response] },
    ]) {
      expect(
        attributeInputResponses({ caller, responder, state: state("tool-approval"), stepInput })
          .caller,
      ).toEqual(responder);
    }
    expect(
      attributeInputResponses({
        caller,
        responder,
        state: state("question"),
        stepInput: { inputResponses: [response] },
      }).caller,
    ).toEqual(responder);
  });
  it("never gives an unauthenticated response the previous user's identity", () => {
    expect(
      attributeInputResponses({
        caller,
        responder: null,
        state: state("session-limit"),
        stepInput: { inputResponses: [response] },
      }).caller,
    ).toBeNull();
  });
});
