import { describe, expect, it } from "vitest";
import type { InputRequest } from "#runtime/input/types.js";
import { resolveTextToResponse, resolveTextToResponses } from "#channel/resolve-text.js";

const APPROVAL_REQUEST: InputRequest = {
  action: { callId: "call-1", input: { command: "rm -rf" }, kind: "tool-call", toolName: "bash" },
  allowFreeform: false,
  display: "confirmation",
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "deny", label: "Deny", style: "danger" },
  ],
  prompt: 'Approve tool "bash"?',
  requestId: "req-1",
};

const SELECT_REQUEST: InputRequest = {
  action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "ask_question" },
  display: "select",
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
  prompt: "What is your name?",
  requestId: "req-3",
};

const SELECT_WITH_FREEFORM_REQUEST: InputRequest = {
  action: { callId: "call-4", input: {}, kind: "tool-call", toolName: "ask_question" },
  allowFreeform: true,
  display: "select",
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

  it("does not match out-of-range numeric index", () => {
    expect(resolveTextToResponse("0", SELECT_REQUEST)).toBeUndefined();
    expect(resolveTextToResponse("4", SELECT_REQUEST)).toBeUndefined();
  });

  it("returns undefined when text does not match any option and freeform is disabled", () => {
    expect(resolveTextToResponse("yes", APPROVAL_REQUEST)).toBeUndefined();
    expect(resolveTextToResponse("sure", APPROVAL_REQUEST)).toBeUndefined();
    expect(resolveTextToResponse("maybe", SELECT_REQUEST)).toBeUndefined();
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

  it("returns empty array when nothing matches", () => {
    const responses = resolveTextToResponses("gibberish", [APPROVAL_REQUEST, SELECT_REQUEST]);
    expect(responses).toEqual([]);
  });

  it("resolves against empty requests", () => {
    expect(resolveTextToResponses("hello", [])).toEqual([]);
  });
});
