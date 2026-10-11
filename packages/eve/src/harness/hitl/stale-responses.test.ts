import { expect, it } from "vitest";

import type { InputRequest } from "#shared/input.js";

import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "#harness/hitl/stale-responses.js";

/** Requests the session still knows, closed ones included. */
const knownApproval = new Map<string, InputRequest>([
  [
    "approval-1",
    {
      action: {
        callId: "call-1",
        input: { command: "deploy --force" },
        kind: "tool-call",
        toolName: "bash",
      },
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: "Approve tool call: bash",
      requestId: "approval-1",
    },
  ],
]);

/** The session no longer knows the request a response answers. */
const unknown = new Map<string, InputRequest>();

it("converts a stale approval into a non-authorizing user message", () => {
  const result = convertStaleResponsesToUserMessage({
    requests: knownApproval,
    pendingRequestIds: new Set(),
    stepInput: {
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Approve");
  expect(result.stepInput.inputResponses).toBeUndefined();
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
    requests: knownApproval,
    pendingRequestIds: new Set(),
    stepInput: {
      attributedInputResponses: [
        {
          auth: {
            attributes: {},
            authenticator: "test",
            principalId: "user-1",
            principalType: "user",
          },
          response: { optionId: "approve", requestId: "approval-1" },
        },
      ],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Approve");
  expect(result.stepInput.attributedInputResponses).toBeUndefined();
  expect(result.stepInput.message).toEqual(expect.stringContaining('"requestType": "approval"'));
});

it("keeps responses for pending requests structured while converting stale ones", () => {
  const result = convertStaleResponsesToUserMessage({
    requests: unknown,
    pendingRequestIds: new Set(["question-2"]),
    stepInput: {
      inputResponses: [
        { optionId: "alpha", requestId: "question-2" },
        { optionId: "candidate", requestId: "question-1" },
      ],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.stepInput.inputResponses).toEqual([{ optionId: "alpha", requestId: "question-2" }]);
  expect(result.stepInput.message).toEqual(expect.stringContaining("question-1"));
  expect(result.stepInput.message).not.toEqual(expect.stringContaining("question-2"));
});

it("keeps the non-authorization notice when request metadata is missing", () => {
  const result = convertStaleResponsesToUserMessage({
    requests: unknown,
    pendingRequestIds: new Set(),
    stepInput: {
      inputResponses: [{ optionId: "approve", requestId: "approval-gone" }],
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
    inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
  };
  const result = convertStaleResponsesToUserMessage({
    requests: knownApproval,
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
      inputResponses: [{ optionId: "stop", requestId: "sess-1:0:limit:input:12" }],
      message: "also do this",
    },
  });

  // Nothing model-visible: a stale "Stop" must not read as prose, and a
  // stale grant must not extend any budget.
  expect(stepInput?.inputResponses).toBeUndefined();
  expect(stepInput?.message).toBe("also do this");
});

it("keeps pending and non-continuation responses while dropping stale continuation answers", () => {
  const stepInput = dropStaleSessionLimitContinuationResponses({
    pendingRequestIds: new Set(["question-1", "sess-1:0:limit:input:20"]),
    stepInput: {
      inputResponses: [
        { optionId: "candidate", requestId: "question-1" },
        { optionId: "continue", requestId: "sess-1:0:limit:input:12" },
        { optionId: "stop", requestId: "sess-1:0:limit:input:20" },
      ],
    },
  });

  // The stale grant is dropped; the pending question answer and the answer
  // to the currently pending continuation prompt pass through.
  expect(stepInput?.inputResponses).toEqual([
    { optionId: "candidate", requestId: "question-1" },
    { optionId: "stop", requestId: "sess-1:0:limit:input:20" },
  ]);
});

it("returns the input unchanged when nothing is dropped", () => {
  const stepInput = {
    inputResponses: [{ optionId: "candidate", requestId: "question-1" }],
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
      inputResponses: [
        { optionId: "candidate", requestId: "question-1" },
        { optionId: "stop", requestId: "sess-1:0:limit:input:12" },
      ],
    },
  });
  const result = convertStaleResponsesToUserMessage({
    requests: unknown,
    pendingRequestIds,
    stepInput,
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.stepInput.inputResponses).toBeUndefined();
  expect(result.stepInput.message).toEqual(expect.stringContaining("question-1"));
  expect(result.stepInput.message).not.toEqual(expect.stringContaining("limit:input"));
});
