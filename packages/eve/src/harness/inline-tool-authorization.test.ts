import type { ToolSet, TypedToolResult } from "ai";
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

describe("resolveInlineAuthorizationInterrupt", () => {
  it("names the calls each sign-in stopped, and ignores calls that ran", () => {
    const authorization = authorizationResult("call-auth", "attempt-1");
    const sibling = {
      input: { action: "complete" },
      output: { type: "text" as const, value: "completed" },
      toolCallId: "call-sibling",
      toolName: "protected_action",
      type: "tool-result" as const,
    };

    const interrupt = resolveInlineAuthorizationInterrupt({
      toolResults: [authorization, sibling],
    });

    expect(interrupt?.challenges).toMatchObject([{ attemptId: "attempt-1" }]);
    expect(interrupt?.calls).toEqual([
      {
        action: {
          callId: "call-auth",
          input: { action: "authorize" },
          kind: "tool-call",
          toolName: "protected_action",
        },
        connections: ["protected_action"],
      },
    ]);
  });

  it("keeps only the latest same-scope challenge", () => {
    const first = authorizationResult("call-first", "attempt-1");
    const latest = authorizationResult("call-latest", "attempt-2");

    expect(
      resolveInlineAuthorizationInterrupt({ toolResults: [first, latest] })?.challenges,
    ).toMatchObject([{ attemptId: "attempt-2" }]);
  });
});
