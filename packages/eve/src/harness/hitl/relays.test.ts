import { describe, expect, it } from "vitest";

import { parseRelay } from "#harness/hitl/relays.js";

describe("parseRelay", () => {
  const remote = { name: "deployer", sessionId: "child-session", url: "https://child.example.com" };

  it("keeps the protocol a remote child speaks, so its answers go back in that protocol", () => {
    expect(
      parseRelay({
        childContinuationToken: "child-hook",
        remote: { ...remote, earlierProtocol: 2 },
      }),
    ).toEqual({ childContinuationToken: "child-hook", remote: { ...remote, earlierProtocol: 2 } });
    expect(parseRelay({ childContinuationToken: "child-hook", remote })).toEqual({
      childContinuationToken: "child-hook",
      remote,
    });
  });

  it("refuses a stored protocol that is not a version", () => {
    for (const earlierProtocol of ["2", 2.5, null]) {
      expect(
        parseRelay({
          childContinuationToken: "child-hook",
          remote: { ...remote, earlierProtocol },
        }),
      ).toBeUndefined();
    }
  });
});
