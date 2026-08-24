import { describe, expect, it } from "vitest";

import { matchAuthorizationCallbacks } from "#execution/authorization-callback-match.js";

describe("matchAuthorizationCallbacks", () => {
  it("preserves the matched legacy challenge candidate ID", () => {
    const pending = {
      challenges: [
        {
          candidateId: "candidate-notion",
          challenge: { url: "https://idp.example/notion" },
          hookUrl: "https://app.example/notion/callback",
          name: "notion",
        },
        {
          candidateId: "candidate-slack",
          challenge: { url: "https://idp.example/slack" },
          hookUrl: "https://app.example/slack/callback",
          name: "slack",
        },
      ],
    };

    const result = matchAuthorizationCallbacks(pending, [
      {
        authorizationCallback: {
          callback: { code: "oauth-code" },
          connectionName: "slack",
          legacy: true,
        },
      },
    ]);

    expect(result.matches).toMatchObject([
      {
        candidateId: "candidate-slack",
        result: { name: "slack" },
      },
    ]);
  });
});
