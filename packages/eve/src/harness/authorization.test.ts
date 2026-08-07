import { describe, expect, it } from "vitest";

import {
  getPendingAuthorization,
  setPendingAuthorization,
  type AuthorizationChallenge,
} from "#harness/authorization.js";

function challenge(name: string, candidateId: string): AuthorizationChallenge {
  return {
    candidateId,
    challenge: { url: `https://example.com/${name}` },
    hookUrl: `https://eve.example/${name}`,
    name,
  };
}

describe("pending authorization state", () => {
  it("merges concurrent candidate challenges by authorization name", () => {
    const first = setPendingAuthorization(undefined, {
      challenges: [challenge("candidate-1:github", "candidate-1")],
    });
    const second = setPendingAuthorization(first, {
      challenges: [challenge("candidate-2:github", "candidate-2")],
    });

    expect(getPendingAuthorization(second)?.challenges).toEqual([
      expect.objectContaining({ candidateId: "candidate-1", name: "candidate-1:github" }),
      expect.objectContaining({ candidateId: "candidate-2", name: "candidate-2:github" }),
    ]);
  });

  it("replaces a repeated challenge without duplicating it", () => {
    const first = setPendingAuthorization(undefined, {
      challenges: [challenge("candidate-1:github", "candidate-1")],
    });
    const second = setPendingAuthorization(first, {
      challenges: [
        {
          ...challenge("candidate-1:github", "candidate-1"),
          hookUrl: "https://eve.example/refreshed",
        },
      ],
    });

    expect(getPendingAuthorization(second)?.challenges).toEqual([
      expect.objectContaining({ hookUrl: "https://eve.example/refreshed" }),
    ]);
  });
});
