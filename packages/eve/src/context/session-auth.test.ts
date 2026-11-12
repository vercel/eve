import { describe, expect, it } from "vitest";

import { samePrincipal } from "#context/session-auth.js";

const alice = {
  attributes: {},
  authenticator: "slack",
  principalId: "alice",
  principalType: "user",
};

describe("samePrincipal", () => {
  it.each([
    ["the same person with different attributes", { ...alice, attributes: { role: "cfo" } }, true],
    ["the same principalId signed in another way", { ...alice, authenticator: "github" }, false],
    ["the same principalId from another issuer", { ...alice, issuer: "other" }, false],
    ["someone who isn't signed in", null, false],
  ])("compares alice with %s", (_label, other, expected) => {
    expect(samePrincipal(alice, other)).toBe(expected);
  });

  it("counts everyone who isn't signed in, or is anonymous, as one person", () => {
    const anonymous = { ...alice, principalId: "visitor", principalType: "anonymous" };
    expect(samePrincipal(null, undefined)).toBe(true);
    expect(samePrincipal(null, anonymous)).toBe(true);
  });
});
