import type { ModelMessage, ToolSet, TypedToolResult } from "ai";
import { describe, expect, it } from "vitest";

import { requestAuthorization } from "#harness/authorization.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";

function authorizationResult(toolCallId: string, attemptId: string) {
  return {
    input: { action: "authorize" },
    output: requestAuthorization([
      {
        attemptId,
        challenge: { url: `https://idp.example/${attemptId}` },
        hookUrl: `https://app.example/${attemptId}`,
        name: "protected_action",
        principal: { type: "app" },
      },
    ]),
    toolCallId,
    toolName: "protected_action",
    type: "tool-result" as const,
  } satisfies TypedToolResult<ToolSet>;
}

const interruptedCall = {
  input: { action: "authorize" },
  toolCallId: "call-auth",
  toolName: "protected_action",
  type: "tool-call" as const,
};

const siblingCall = {
  input: { action: "complete" },
  toolCallId: "call-sibling",
  toolName: "protected_action",
  type: "tool-call" as const,
};

const siblingResult = {
  input: siblingCall.input,
  output: { type: "text" as const, value: "completed" },
  toolCallId: siblingCall.toolCallId,
  toolName: siblingCall.toolName,
  type: "tool-result" as const,
};

function modelResult(result: ReturnType<typeof authorizationResult>) {
  return {
    input: result.input,
    output: { type: "text" as const, value: "Authorization required." },
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    type: "tool-result" as const,
  };
}

describe("resolveInlineAuthorizationInterrupt", () => {
  it("removes an interrupted call, its result, and its orphaned assistant text", () => {
    const messages: ModelMessage[] = [
      {
        content: [{ text: "I'll authorize this action.", type: "text" }, interruptedCall],
        role: "assistant",
      },
      {
        content: [modelResult(authorizationResult(interruptedCall.toolCallId, "attempt-1"))],
        role: "tool",
      },
    ];

    expect(
      resolveInlineAuthorizationInterrupt({
        messages,
        toolResults: [authorizationResult(interruptedCall.toolCallId, "attempt-1")],
      }),
    ).toMatchObject({
      challenges: [{ attemptId: "attempt-1" }],
      history: [],
    });
  });

  it("preserves protocol-complete sibling calls and results", () => {
    const authorization = authorizationResult(interruptedCall.toolCallId, "attempt-1");
    const messages: ModelMessage[] = [
      {
        content: [interruptedCall, siblingCall],
        role: "assistant",
      },
      {
        content: [modelResult(authorization), siblingResult],
        role: "tool",
      },
    ];

    expect(
      resolveInlineAuthorizationInterrupt({
        messages,
        toolResults: [authorization, siblingResult],
      })?.history,
    ).toEqual([
      { content: [siblingCall], role: "assistant" },
      { content: [siblingResult], role: "tool" },
    ]);
  });

  it("keeps only the latest same-scope challenge", () => {
    const first = authorizationResult("call-first", "attempt-1");
    const latest = authorizationResult("call-latest", "attempt-2");

    expect(
      resolveInlineAuthorizationInterrupt({
        messages: [],
        toolResults: [first, latest],
      })?.challenges,
    ).toMatchObject([{ attemptId: "attempt-2" }]);
  });
});
