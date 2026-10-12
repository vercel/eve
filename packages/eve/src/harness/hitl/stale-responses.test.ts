import { expect, it } from "vitest";

import { tablesOf } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";

import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "#harness/hitl/stale-responses.js";

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

/** The session no longer knows the request a response answers. */
const unknown = tablesOf([]);

it("converts a stale approval into a non-authorizing user message", () => {
  const result = convertStaleResponsesToUserMessage({
    view: knownApproval,
    pendingRequestIds: new Set(),
    stepInput: {
      answers: [{ optionId: "approve", interactionId: "approval-1" }],
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
      attributedAnswers: [
        {
          auth: {
            attributes: {},
            authenticator: "test",
            principalId: "user-1",
            principalType: "user",
          },
          response: { optionId: "approve", interactionId: "approval-1" },
        },
      ],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Approve");
  expect(result.stepInput.attributedAnswers).toBeUndefined();
  expect(result.stepInput.message).toEqual(expect.stringContaining('"requestType": "approval"'));
});

it("keeps responses for pending requests structured while converting stale ones", () => {
  const result = convertStaleResponsesToUserMessage({
    view: unknown,
    pendingRequestIds: new Set(["question-2"]),
    stepInput: {
      answers: [
        { optionId: "alpha", interactionId: "question-2" },
        { optionId: "candidate", interactionId: "question-1" },
      ],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.stepInput.answers).toEqual([{ optionId: "alpha", interactionId: "question-2" }]);
  expect(result.stepInput.message).toEqual(expect.stringContaining("question-1"));
  expect(result.stepInput.message).not.toEqual(expect.stringContaining("question-2"));
});

it("keeps the non-authorization notice when request metadata is missing", () => {
  const result = convertStaleResponsesToUserMessage({
    view: unknown,
    pendingRequestIds: new Set(),
    stepInput: {
      answers: [{ optionId: "approve", interactionId: "approval-gone" }],
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
    answers: [{ optionId: "approve", interactionId: "approval-1" }],
  };
  const result = convertStaleResponsesToUserMessage({
    view: knownApproval,
    pendingRequestIds: new Set(["approval-1"]),
    stepInput,
  });

  expect(result.kind).toBe("unchanged");
  expect(result.stepInput).toBe(stepInput);
});

it("drops a stale session-limit continuation answer and keeps the rest of the input", () => {
  const stepInput = dropStaleSessionLimitContinuationResponses({
    pendingRequestIds: new Set(),
    stepInput: {
      answers: [{ optionId: "stop", interactionId: "sess-1:0:limit:input:12" }],
      message: "also do this",
    },
  });

  // Nothing model-visible: a stale "Stop" must not read as prose, and a
  // stale grant must not extend any budget.
  expect(stepInput?.answers).toBeUndefined();
  expect(stepInput?.message).toBe("also do this");
});

it("keeps pending and non-continuation responses while dropping stale continuation answers", () => {
  const stepInput = dropStaleSessionLimitContinuationResponses({
    pendingRequestIds: new Set(["question-1", "sess-1:0:limit:input:20"]),
    stepInput: {
      answers: [
        { optionId: "candidate", interactionId: "question-1" },
        { optionId: "continue", interactionId: "sess-1:0:limit:input:12" },
        { optionId: "stop", interactionId: "sess-1:0:limit:input:20" },
      ],
    },
  });

  // The stale grant is dropped; the pending question answer and the answer
  // to the currently pending continuation prompt pass through.
  expect(stepInput?.answers).toEqual([
    { optionId: "candidate", interactionId: "question-1" },
    { optionId: "stop", interactionId: "sess-1:0:limit:input:20" },
  ]);
});

it("returns the input unchanged when nothing is dropped", () => {
  const stepInput = {
    answers: [{ optionId: "candidate", interactionId: "question-1" }],
  };

  expect(
    dropStaleSessionLimitContinuationResponses({
      pendingRequestIds: new Set(),
      stepInput,
    }),
  ).toBe(stepInput);
});

it("converts remaining stale responses after the drop pass", () => {
  const pendingRequestIds = new Set<string>();
  const stepInput = dropStaleSessionLimitContinuationResponses({
    pendingRequestIds,
    stepInput: {
      answers: [
        { optionId: "candidate", interactionId: "question-1" },
        { optionId: "stop", interactionId: "sess-1:0:limit:input:12" },
      ],
    },
  });
  const result = convertStaleResponsesToUserMessage({
    view: unknown,
    pendingRequestIds,
    stepInput,
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.stepInput.answers).toBeUndefined();
  expect(result.stepInput.message).toEqual(expect.stringContaining("question-1"));
  expect(result.stepInput.message).not.toEqual(expect.stringContaining("limit:input"));
});
