import { describe, expect, it } from "vitest";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";
import type { PendingAuthorizationState } from "#harness/authorization.js";

describe("matchAuthorizationCallbacks", () => {
  it("carries the resolved connection instance into the callback result", () => {
    const pending: PendingAuthorizationState = {
      challenges: [
        {
          attemptId: "attempt-1",
          challenge: { url: "https://auth.example.com" },
          hookUrl: "https://app.example.com/callback",
          instanceId: "connection:instance-a",
          name: "crm",
          principal: { type: "app" },
        },
      ],
    };

    const result = matchAuthorizationCallbacks(pending, [
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
