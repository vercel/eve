import { describe, expect, it } from "vitest";

import { requestAuthorization } from "#harness/authorization.js";
import type { ToolSignIn } from "#harness/call-executor.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";

function signIn(callId: string, attemptId: string): ToolSignIn {
  return {
    callId,
    input: { action: "authorize" },
    signal: requestAuthorization([
      {
        attemptId,
        challenge: { url: `https://idp.example/${attemptId}` },
        hookUrl: `https://app.example/${attemptId}`,
        name: "protected_action",
        principal: { type: "app" },
      },
    ]),
    toolName: "protected_action",
  };
}

describe("resolveInlineAuthorizationInterrupt", () => {
  it("names the calls each sign-in stopped", () => {
    const interrupt = resolveInlineAuthorizationInterrupt({
      signIns: [signIn("call-auth", "attempt-1")],
    });

    expect(interrupt?.challenges).toMatchObject([{ attemptId: "attempt-1" }]);
    expect(interrupt?.calls).toEqual([
      {
        call: { callId: "call-auth", input: { action: "authorize" }, toolName: "protected_action" },
        connections: ["protected_action"],
      },
    ]);
  });

  it("is undefined when no call stopped for a sign-in", () => {
    expect(resolveInlineAuthorizationInterrupt({ signIns: [] })).toBeUndefined();
  });

  it("keeps only the latest same-scope challenge", () => {
    expect(
      resolveInlineAuthorizationInterrupt({
        signIns: [signIn("call-first", "attempt-1"), signIn("call-latest", "attempt-2")],
      })?.challenges,
    ).toMatchObject([{ attemptId: "attempt-2" }]);
  });
});
