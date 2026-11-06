import { describe, expect, it } from "vitest";

import { ConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  createRuntimeToolResultFromToolError,
  createRuntimeToolResultFromValue,
} from "#harness/action-result-helpers.js";

describe("createRuntimeToolResultFromValue", () => {
  it("rejects non-JSON-serializable successful action results", () => {
    expect(() =>
      createRuntimeToolResultFromValue({
        callId: "call_timestamp",
        output: { now: new Date("2026-01-02T03:04:05.000Z") },
        toolName: "timestamp",
      }),
    ).toThrow(
      'Tool "timestamp" call "call_timestamp" produced a non-JSON-serializable action result. Expected a JSON-serializable value.',
    );
  });

  it("normalizes top-level undefined action results to null", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_empty",
        output: undefined,
        toolName: "empty",
      }),
    ).toEqual({
      callId: "call_empty",
      kind: "tool-result",
      output: null,
      toolName: "empty",
    });
  });

  it("projects Error instances for failed action results to their message", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_failed",
        isError: true,
        output: Object.assign(new Error("tool failed"), { name: "QuotaError" }),
        toolName: "broken",
      }),
    ).toEqual({
      callId: "call_failed",
      errorName: "QuotaError",
      isError: true,
      kind: "tool-result",
      output: "tool failed",
      toolName: "broken",
    });
  });

  it("keeps the reason of a failed authorization as the error code", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_gh",
        isError: true,
        output: new ConnectionAuthorizationFailedError("github", {
          message: "rejected",
          reason: "token_rejected_after_authorization",
          retryable: false,
        }),
        toolName: "gh",
      }),
    ).toEqual({
      callId: "call_gh",
      errorCode: "token_rejected_after_authorization",
      errorName: "ConnectionAuthorizationFailedError",
      isError: true,
      kind: "tool-result",
      output: "rejected",
      toolName: "gh",
    });
  });
});

describe("createRuntimeToolResultFromToolError", () => {
  it("projects AI SDK tool-error parts as failed action results", () => {
    expect(
      createRuntimeToolResultFromToolError({
        error: new Error('No skill named "demo"'),
        input: { skill: "demo" },
        toolCallId: "call_lookup",
        toolName: "lookup",
        type: "tool-error",
      }),
    ).toEqual({
      callId: "call_lookup",
      errorName: "Error",
      isError: true,
      kind: "tool-result",
      output: 'No skill named "demo"',
      toolName: "lookup",
    });
  });
});
