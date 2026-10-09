import { describe, expect, it } from "vitest";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";

describe("matchAuthorizationCallbacks", () => {
  it.each([undefined, "another-attempt"])("ignores an unmatched attempt %s", (attemptId) => {
    const result = matchAuthorizationCallbacks(
      [
        {
          attemptId: "attempt-1",
          name: "crm",
          hookUrl: "https://app.example/callback",
          challenge: {},
          principal: { type: "app" },
        },
      ],
      [
        {
          authorizationCallback: {
            attemptId,
            connectionName: "crm",
            callback: { params: {} },
          },
        },
      ],
    );
    expect(result.matches).toEqual([]);
  });

  it("consumes one callback per attempt and preserves unrelated delivery", () => {
    const callback = {
      authorizationCallback: {
        attemptId: "attempt-1",
        connectionName: "crm",
        callback: { params: {} },
      },
    };
    const message = { message: "Continue after signing in" };
    const result = matchAuthorizationCallbacks(
      [
        {
          attemptId: "attempt-1",
          name: "crm",
          hookUrl: "https://app.example/callback",
          challenge: {},
          principal: { type: "app" },
        },
      ],
      [callback, message, callback],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.remainingPayloads).toEqual([message]);
  });

  it("carries the resolved connection instance into the callback result", () => {
    const signIns: AuthorizationChallenge[] = [
      {
        attemptId: "attempt-1",
        challenge: { url: "https://auth.example.com" },
        hookUrl: "https://app.example.com/callback",
        instanceId: "connection:instance-a",
        name: "crm",
        principal: { type: "app" },
      },
    ];

    const result = matchAuthorizationCallbacks(signIns, [
      {
        authorizationCallback: {
          attemptId: "attempt-1",
          callback: { params: { code: "callback-code" } },
          connectionName: "crm",
        },
      },
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.result.instanceId).toBe("connection:instance-a");
    expect(result.remainingPayloads).toEqual([]);
  });
});
