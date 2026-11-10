import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SenderAuthKey } from "#context/keys.js";
import { enterParticipants, rememberSender } from "#harness/sender-line.js";
import type { SessionStateMap } from "#harness/types.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import type { ConnectionPrincipal } from "#shared/connection-types.js";

const alice = {
  attributes: {},
  authenticator: "slack",
  principalId: "alice",
  principalType: "user",
};
const bob = { authenticator: "slack", principalId: "bob", principalType: "user" };
const PROVIDER = {
  getToken: async () => ({ token: "token" }),
  principalType: "user" as const,
};

describe("ctx.getToken with as", () => {
  it.each([
    [
      "two people who have spoken share, signed in different ways",
      "bob",
      [bob, { ...bob, authenticator: "github" }],
    ],
    [
      "the caller shares with someone signed in another way",
      "alice",
      [{ authenticator: "github", principalId: "alice", principalType: "user" }],
    ],
  ])("refuses a principalId %s", async (_label, as, participants) => {
    const ctx = new ContextContainer();
    ctx.set(AuthKey, alice);
    enterParticipants(ctx, () => ({ "eve.harness.participants": participants }));

    const refusal = await contextStorage
      .run(ctx, () => createAuthorizationContext({ scope: "inbox" }).getToken(PROVIDER, { as }))
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      name: "ConnectionAuthorizationFailedError",
      reason: "principal_ambiguous",
      retryable: false,
    });
  });

  it("hands a named person's provider and result no attributes, neither theirs nor the caller's", async () => {
    const ctx = new ContextContainer();
    ctx.set(AuthKey, { ...alice, attributes: { email: "alice@example.com" } });
    const bobAuth = { ...bob, attributes: { email: "bob@example.com" } };
    // Bob spoke last, so his identity is his to hand out, and the session recorded him.
    ctx.set(SenderAuthKey, bobAuth);
    const session: { readonly state?: SessionStateMap } = {};
    const { state } = rememberSender(session, bobAuth);
    enterParticipants(ctx, () => state);
    const received: ConnectionPrincipal[] = [];

    const result = await contextStorage.run(ctx, () =>
      createAuthorizationContext({ scope: "inbox" }).getToken(
        {
          getToken: async ({ principal }) => {
            received.push(principal);
            return { token: "token" };
          },
          principalType: "user",
        },
        { as: "bob" },
      ),
    );

    expect(received).toEqual([{ attributes: {}, id: "bob", issuer: "slack", type: "user" }]);
    expect(result.principal).toEqual({ ...bob, attributes: {} });
    // The session's record of who spoke, which it persists, keeps none either.
    expect(JSON.stringify(state)).not.toContain("example.com");
  });
});
