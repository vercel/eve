import { describe, expect, it } from "vitest";
import type { InputRequest } from "#runtime/input/types.js";
import { resolveTextToResponse, resolveTextToResponses } from "#channel/resolve-text.js";

const APPROVAL_REQUEST: InputRequest = {
  action: { callId: "call-1", input: { command: "rm -rf" }, kind: "tool-call", toolName: "bash" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "cancel", label: "Cancel", style: "danger" },
  ],
  prompt: 'Approve tool "bash"?',
  requestId: "req-1",
};

const SELECT_REQUEST: InputRequest = {
  action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "ask_question" },
  allowFreeform: false,
  display: "select",
  kind: "question",
  options: [
    { id: "postgres", label: "Postgres" },
    { id: "mysql", label: "MySQL" },
    { id: "sqlite", label: "SQLite" },
  ],
  prompt: "Which database?",
  requestId: "req-2",
};

const FREEFORM_REQUEST: InputRequest = {
  action: { callId: "call-3", input: {}, kind: "tool-call", toolName: "ask_question" },
  allowFreeform: true,
  display: "text",
  kind: "question",
  prompt: "What is your name?",
  requestId: "req-3",
};

const SELECT_WITH_FREEFORM_REQUEST: InputRequest = {
  action: { callId: "call-4", input: {}, kind: "tool-call", toolName: "ask_question" },
  allowFreeform: true,
  display: "select",
  kind: "question",
  options: [
    { id: "red", label: "Red" },
    { id: "blue", label: "Blue" },
  ],
  prompt: "Pick a color or enter a custom one.",
  requestId: "req-4",
};

describe("resolveTextToResponse", () => {
  it("returns undefined for empty text", () => {
    expect(resolveTextToResponse("", APPROVAL_REQUEST)).toBeUndefined();
  });

  it("returns undefined for whitespace-only text", () => {
    expect(resolveTextToResponse("   ", APPROVAL_REQUEST)).toBeUndefined();
  });

  it("matches option by exact ID (case-insensitive)", () => {
    expect(resolveTextToResponse("approve", APPROVAL_REQUEST)).toEqual({
      requestId: "req-1",
      optionId: "approve",
    });
    expect(resolveTextToResponse("APPROVE", APPROVAL_REQUEST)).toEqual({
      requestId: "req-1",
      optionId: "approve",
    });
  });

  it("matches option by exact label (case-insensitive)", () => {
    expect(resolveTextToResponse("Postgres", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      optionId: "postgres",
    });
    expect(resolveTextToResponse("mysql", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      optionId: "mysql",
    });
  });

  it("matches option by 1-based numeric index", () => {
    expect(resolveTextToResponse("1", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      optionId: "postgres",
    });
    expect(resolveTextToResponse("3", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      optionId: "sqlite",
    });
  });

  it("preserves out-of-range numeric question input as text", () => {
    expect(resolveTextToResponse("0", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      text: "0",
    });
    expect(resolveTextToResponse("4", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      text: "4",
    });
  });

  it("returns undefined when approval text does not match any option", () => {
    expect(resolveTextToResponse("yes", APPROVAL_REQUEST)).toBeUndefined();
    expect(resolveTextToResponse("sure", APPROVAL_REQUEST)).toBeUndefined();
  });

  it("preserves unmatched question input as text", () => {
    expect(resolveTextToResponse("analyze both", SELECT_REQUEST)).toEqual({
      requestId: "req-2",
      text: "analyze both",
    });
  });

  it("leaves unmatched question input unresolved when preservation is disabled", () => {
    expect(
      resolveTextToResponse("analyze both", SELECT_REQUEST, {
        preserveUnmatchedQuestionText: false,
      }),
    ).toBeUndefined();
  });

  it("falls back to freeform text when allowFreeform is true", () => {
    expect(resolveTextToResponse("Alice", FREEFORM_REQUEST)).toEqual({
      requestId: "req-3",
      text: "Alice",
    });
  });

  it("matches option first, freeform second when both available", () => {
    expect(resolveTextToResponse("red", SELECT_WITH_FREEFORM_REQUEST)).toEqual({
      requestId: "req-4",
      optionId: "red",
    });
    expect(resolveTextToResponse("green", SELECT_WITH_FREEFORM_REQUEST)).toEqual({
      requestId: "req-4",
      text: "green",
    });
  });

  it("falls back to freeform for requests with no options", () => {
    const noOptions: InputRequest = {
      action: { callId: "call-5", input: {}, kind: "tool-call", toolName: "ask_question" },
      kind: "question",
      prompt: "Tell me something.",
      requestId: "req-5",
    };
    expect(resolveTextToResponse("anything", noOptions)).toEqual({
      requestId: "req-5",
      text: "anything",
    });
  });

  it("trims whitespace from input", () => {
    expect(resolveTextToResponse("  approve  ", APPROVAL_REQUEST)).toEqual({
      requestId: "req-1",
      optionId: "approve",
    });
  });
});

describe("resolveTextToResponses", () => {
  it("resolves text against multiple requests", () => {
    const responses = resolveTextToResponses("approve", [APPROVAL_REQUEST, FREEFORM_REQUEST]);
    expect(responses).toEqual([
      { requestId: "req-1", optionId: "approve" },
      { requestId: "req-3", text: "approve" },
    ]);
  });

  it("returns responses only for requests that accept the text", () => {
    const responses = resolveTextToResponses("gibberish", [APPROVAL_REQUEST, SELECT_REQUEST]);
    expect(responses).toEqual([{ requestId: "req-2", text: "gibberish" }]);
  });

  it("resolves against empty requests", () => {
    expect(resolveTextToResponses("hello", [])).toEqual([]);
  });
});
