import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ActivityPendingBlockersKey, ActivityRootTurnIdKey } from "#context/keys.js";
import { restoreAuthorizationActivity } from "#execution/activity-cohort.js";
import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";

describe("restoreAuthorizationActivity", () => {
  it("restores authorization activity by attempt ID", () => {
    const ctx = new ContextContainer();
    const pending = {
      activityRootTurnIds: { "attempt-1": "turn-origin" },
      challenges: [
        {
          attemptId: "attempt-1",
          candidateId: "candidate-1",
          challenge: { url: "https://auth.example.com" },
          hookUrl: "https://app.example.com/callback",
          name: "github",
          principal: { type: "app" as const },
        },
      ],
    };
    const { matches } = matchAuthorizationCallbacks(pending, [
      {
        authorizationCallback: {
          attemptId: "attempt-1",
          callback: { params: { code: "callback-code" } },
          connectionName: "github",
        },
      },
    ]);

    const ids = restoreAuthorizationActivity({ ctx, matches, pending });

    expect(ids).toEqual(["attempt-1"]);
    expect(ctx.get(ActivityRootTurnIdKey)).toBe("turn-origin");
    expect(ctx.get(ActivityPendingBlockersKey)).toBeUndefined();
  });
});
