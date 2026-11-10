import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { enterParticipants } from "#harness/sender-line.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";

const alice = {
  attributes: {},
  authenticator: "slack",
  principalId: "alice",
  principalType: "user",
};
const PROVIDER = {
  getToken: async () => ({ token: "token" }),
  principalType: "user" as const,
};

describe("ctx.getToken with as", () => {
  it("refuses a principalId two people who have spoken share, signed in different ways", async () => {
    const ctx = new ContextContainer();
    ctx.set(AuthKey, alice);
    const bob = { authenticator: "slack", principalId: "bob", principalType: "user" };
    enterParticipants(ctx, () => ({
      "eve.harness.participants": [bob, { ...bob, authenticator: "github" }],
    }));

    const refusal = await contextStorage
      .run(ctx, () =>
        createAuthorizationContext({ scope: "inbox" }).getToken(PROVIDER, { as: "bob" }),
      )
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      name: "ConnectionAuthorizationFailedError",
      reason: "person_ambiguous",
      retryable: false,
    });
  });
});
