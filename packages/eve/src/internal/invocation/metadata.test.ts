import { describe, expect, it } from "vitest";

import { none } from "#channel/auth/definitions.js";
import { sessionAuthFromResult } from "#channel/auth/result.js";
import type { SessionAuthContext } from "#channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

describe("invocationOwnerKey", () => {
  it("gives a null principal and the anonymous route principal the same key", async () => {
    const anonymous = sessionAuthFromResult((await none()(undefined)) as SessionAuthContext);

    expect(invocationOwnerKey(anonymous)).toBe(invocationOwnerKey(null));
  });

  it("gives an authenticated principal a key that differs from anonymous", () => {
    expect(invocationOwnerKey(alice)).not.toBe(invocationOwnerKey(null));
  });

  it("ignores attributes and distinguishes subject and issuer", () => {
    expect(invocationOwnerKey({ ...alice, attributes: { a: "b" } })).toBe(
      invocationOwnerKey(alice),
    );
    expect(invocationOwnerKey({ ...alice, issuer: "https://issuer" })).not.toBe(
      invocationOwnerKey(alice),
    );
    expect(invocationOwnerKey({ ...alice, subject: "s" })).not.toBe(invocationOwnerKey(alice));
  });
});
