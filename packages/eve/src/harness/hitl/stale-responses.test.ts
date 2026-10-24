import { expect, it } from "vitest";

import { tablesOf } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

import { convertStaleResponsesToUserMessage } from "#harness/hitl/stale-responses.js";

/** The tables of a session that asked to approve a call, which closed. */
const knownApproval = tablesOf([
  { data: {}, type: "session.started" },
  {
    data: { cause: { deliveryId: "d0" }, follows: null, turnId: "turn_0" },
    type: "turn.started",
  },
  {
    data: { owner: { turnId: "turn_0" }, runId: "run_0" },
    scope: { turnId: "turn_0" },
    type: "model.requested",
  },
  {
    data: {
      callId: "call-1",
      capability: { kind: "tool", name: "bash" },
      input: { command: "deploy --force" },
      owner: { runId: "run_0" },
    },
    scope: { turnId: "turn_0" },
    type: "call.requested",
  },
  {
    data: {
      interactionId: "approval-1",
      request: {
        kind: "approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve tool call: bash",
      },
      subject: { callId: "call-1" },
    },
    scope: { turnId: "turn_0" },
    type: "interaction.opened",
  },
] as SessionEvent[]);

/** An answer as the session received it, from one delivery. */
function submitted(interactionId: string, optionId: string) {
  return {
    deliveryId: "delivery-1",
    interactionId,
    optionId,
    responseId: `response-${interactionId}`,
  };
}

/** The session no longer knows the request a response answers. */
const unknown = tablesOf([]);

it("converts a stale approval into a non-authorizing user message", () => {
  const result = convertStaleResponsesToUserMessage({
    view: knownApproval,
    pendingRequestIds: new Set(),
    stepInput: {
      answers: [submitted("approval-1", "approve")],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Approve");
  expect(result.stepInput.answers).toBeUndefined();
  expect(result.stepInput.message).toEqual(
    expect.stringContaining('"prompt": "Approve tool call: bash"'),
  );
  expect(result.stepInput.message).toEqual(expect.stringContaining('"toolName": "bash"'));
  expect(result.stepInput.message).toEqual(expect.stringContaining('"label": "Approve"'));
  expect(result.stepInput.message).toEqual(
    expect.stringContaining("This does not authorize an earlier action"),
  );
});

it("converts an attributed stale approval using its option label", () => {
  const result = convertStaleResponsesToUserMessage({
    view: knownApproval,
    pendingRequestIds: new Set(),
    stepInput: {
      answers: [
        {
          ...submitted("approval-1", "approve"),
          responder: {
            attributes: {},
            authenticator: "test",
            principalId: "user-1",
            principalType: "user",
          },
        },
      ],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Approve");
  expect(result.stepInput.answers).toBeUndefined();
  expect(result.stepInput.message).toEqual(expect.stringContaining('"requestType": "approval"'));
});

it("keeps responses for pending requests structured while converting stale ones", () => {
  const result = convertStaleResponsesToUserMessage({
    view: unknown,
    pendingRequestIds: new Set(["question-2"]),
    stepInput: {
      answers: [submitted("question-2", "alpha"), submitted("question-1", "candidate")],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.stepInput.answers).toEqual([submitted("question-2", "alpha")]);
  expect(result.stepInput.message).toEqual(expect.stringContaining("question-1"));
  expect(result.stepInput.message).not.toEqual(expect.stringContaining("question-2"));
});

it("keeps the non-authorization notice when request metadata is missing", () => {
  const result = convertStaleResponsesToUserMessage({
    view: unknown,
    pendingRequestIds: new Set(),
    stepInput: {
      answers: [submitted("approval-gone", "approve")],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("approve");
  expect(result.stepInput.message).toEqual(expect.stringContaining("approval-gone"));
  expect(result.stepInput.message).toEqual(
    expect.stringContaining("This does not authorize an earlier action"),
  );
});

it("returns unchanged when every response matches the pending batch", () => {
  const stepInput = {
    answers: [submitted("approval-1", "approve")],
  };
  const result = convertStaleResponsesToUserMessage({
    view: knownApproval,
    pendingRequestIds: new Set(["approval-1"]),
    stepInput,
  });

  expect(result.kind).toBe("unchanged");
  expect(result.stepInput).toBe(stepInput);
});
