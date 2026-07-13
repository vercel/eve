import { describe, expect, it } from "vitest";

import {
  inputRequestSchema,
  inputResponseSchema,
  isInputRequest,
  isInputResponse,
} from "#runtime/input/types.js";

describe("inputRequestSchema", () => {
  it("accepts a confirmation request (approval)", () => {
    const value = {
      action: {
        callId: "call-1",
        input: { command: "pwd" },
        kind: "tool-call",
        toolName: "bash",
      },
      allowFreeform: false,
      display: "confirmation",
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      prompt: 'Approve tool "bash"?',
      requestId: "approval-1",
    };

    expect(inputRequestSchema.parse(value)).toEqual(value);
    expect(isInputRequest(value)).toBe(true);
  });

  it("accepts a select request (question with options)", () => {
    const value = {
      action: {
        callId: "call-2",
        input: {
          options: [{ id: "yes", label: "Yes" }],
          prompt: "Continue?",
        },
        kind: "tool-call",
        toolName: "ask_question",
      },
      display: "select",
      options: [{ id: "yes", label: "Yes" }],
      prompt: "Continue?",
      requestId: "call-2",
    };

    expect(inputRequestSchema.parse(value)).toEqual(value);
    expect(isInputRequest(value)).toBe(true);
  });

  it("accepts a text request (freeform question)", () => {
    const value = {
      action: {
        callId: "call-3",
        input: { prompt: "What is your name?" },
        kind: "tool-call",
        toolName: "ask_question",
      },
      allowFreeform: true,
      display: "text",
      prompt: "What is your name?",
      requestId: "call-3",
    };

    expect(inputRequestSchema.parse(value)).toEqual(value);
    expect(isInputRequest(value)).toBe(true);
  });

  it("accepts a minimal request without optional fields", () => {
    const value = {
      action: {
        callId: "call-4",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      prompt: "Are you sure?",
      requestId: "req-4",
    };

    expect(inputRequestSchema.parse(value)).toEqual(value);
    expect(isInputRequest(value)).toBe(true);
  });

  it("rejects unknown fields", () => {
    const value = {
      action: {
        callId: "call-5",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      prompt: "Hello?",
      requestId: "req-5",
      unknown: true,
    };

    expect(() => inputRequestSchema.parse(value)).toThrow();
  });
});

describe("inputResponseSchema", () => {
  it("accepts an option response", () => {
    const value = {
      optionId: "approve",
      requestId: "req-1",
    };

    expect(inputResponseSchema.parse(value)).toEqual(value);
    expect(isInputResponse(value)).toBe(true);
  });

  it("accepts a text response", () => {
    const value = {
      requestId: "req-2",
      text: "My name is Alice",
    };

    expect(inputResponseSchema.parse(value)).toEqual(value);
    expect(isInputResponse(value)).toBe(true);
  });

  it("accepts a minimal response (requestId only)", () => {
    const value = {
      requestId: "req-3",
    };

    expect(inputResponseSchema.parse(value)).toEqual(value);
    expect(isInputResponse(value)).toBe(true);
  });
});
