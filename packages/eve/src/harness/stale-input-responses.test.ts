import { expect, it } from "vitest";

import type { ModelMessage } from "ai";

import { convertStaleResponsesToUserMessage } from "#harness/stale-input-responses.js";

const approvalHistory: ModelMessage[] = [
  {
    content: [
      {
        input: { command: "deploy --force" },
        toolCallId: "call-1",
        toolName: "bash",
        type: "tool-call",
      },
      {
        approvalId: "approval-1",
        toolCallId: "call-1",
        type: "tool-approval-request",
      },
    ],
    role: "assistant",
  },
];

const questionHistory: ModelMessage[] = [
  {
    content: [
      {
        input: {
          allowFreeform: true,
          options: [
            { id: "current", label: "Use current context" },
            { id: "candidate", label: "Use the candidate" },
          ],
          prompt: "Which context should I use?",
        },
        toolCallId: "question-1",
        toolName: "ask_question",
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
];

it("converts a stale approval into a non-authorizing user message", () => {
  const result = convertStaleResponsesToUserMessage({
    history: approvalHistory,
    pendingRequestIds: new Set(),
    stepInput: {
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Yes");
  expect(result.stepInput.inputResponses).toBeUndefined();
  expect(result.stepInput.message).toEqual(expect.stringContaining("Approve tool call: bash"));
  expect(result.stepInput.message).toEqual(expect.stringContaining('"label": "Yes"'));
  expect(result.stepInput.message).toEqual(
    expect.stringContaining("This does not authorize an earlier action"),
  );
});

it("converts a stale question selection using its option label", () => {
  const result = convertStaleResponsesToUserMessage({
    history: questionHistory,
    pendingRequestIds: new Set(),
    stepInput: {
      inputResponses: [{ optionId: "candidate", requestId: "question-1" }],
    },
  });

  expect(result.kind).toBe("converted");
  if (result.kind !== "converted") {
    throw new Error("Expected the stale response to be converted.");
  }

  expect(result.displayMessage).toBe("Use the candidate");
  expect(result.stepInput.message).toEqual(expect.stringContaining("Which context should I use?"));
  expect(result.stepInput.message).toEqual(expect.stringContaining('"requestType": "question"'));
  expect(result.stepInput.message).not.toEqual(
    expect.stringContaining("This does not authorize an earlier action"),
  );
});

it("keeps responses for pending requests structured while converting stale ones", () => {
  const result = convertStaleResponsesToUserMessage({
    history: questionHistory,
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
    history: [],
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
    history: approvalHistory,
    pendingRequestIds: new Set(["approval-1"]),
    stepInput,
  });

  expect(result.kind).toBe("unchanged");
  expect(result.stepInput).toBe(stepInput);
});
