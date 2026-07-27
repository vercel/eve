import { describe, expect, it } from "vitest";

import { toObservableUserIdentity } from "#runtime/sessions/observable-user.js";

describe("toObservableUserIdentity", () => {
  it("projects the stable id and optional display name", () => {
    expect(
      toObservableUserIdentity({
        attributes: { display_name: "Ada Lovelace", email: "ada@example.com" },
        authenticator: "slack-webhook",
        issuer: "slack:T1",
        principalId: "slack:T1:U1",
        principalType: "user",
      }),
    ).toEqual({ displayName: "Ada Lovelace", id: "slack:T1:U1" });
  });

  it("omits non-user and missing identities", () => {
    expect(toObservableUserIdentity(null)).toBeUndefined();
    expect(
      toObservableUserIdentity({
        attributes: {},
        authenticator: "app",
        principalId: "eve:app",
        principalType: "runtime",
      }),
    ).toBeUndefined();
  });
});
