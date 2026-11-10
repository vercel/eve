import { expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, DelegatedIdentityKey, SenderAuthKey } from "#context/keys.js";
import { principalOf } from "#context/session-auth.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  identityRequestOf,
  rememberedConfirmations,
  requireCallerConfirmation,
  withCallIdentity,
} from "#runtime/connections/caller-confirmation.js";

const alice = {
  attributes: {},
  authenticator: "slack",
  principalId: "alice",
  principalType: "user",
};

it.each([
  ["someone signed in", { ...alice, principalId: "bob" }, true],
  ["someone anonymous", { ...alice, principalId: "anon-1", principalType: "anonymous" }, false],
])(
  'with callerConfirmation "once", remembers an approval after %s: %s',
  (_label, sender, remembers) => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, {
      graph: {
        nodesByNodeId: new Map([
          ["__root__", { agent: { config: { callerConfirmation: "once" } } }],
        ]),
      },
    } as never);
    ctx.set(AuthKey, alice);
    ctx.set(SenderAuthKey, sender);

    let refusal: unknown;
    try {
      requireCallerConfirmation("inbox", ctx);
    } catch (error) {
      refusal = error;
    }

    // Every anonymous person shares one identity, so an approval after one would cover them all.
    expect(identityRequestOf(refusal)?.remember !== undefined).toBe(remembers);
  },
);

it.each([
  ["the same caller and sender", "alice", "bob", true],
  ["another sender", "alice", "carol", false],
  ["another caller", "dave", "bob", false],
])(
  'releases the caller\'s identity in a local child for a "once" approval inherited for %s: %s',
  (_label, caller, sender, released) => {
    const person = (principalId: string) => ({ ...alice, principalId });
    const ctx = new ContextContainer();
    ctx.set(BundleKey, {
      graph: {
        nodesByNodeId: new Map([
          ["__root__", { agent: { config: { callerConfirmation: "once" } } }],
        ]),
      },
    } as never);
    ctx.set(AuthKey, person(caller));
    ctx.set(SenderAuthKey, person(sender));
    // In the parent, Alice approved a call after Bob spoke.
    ctx.set(DelegatedIdentityKey, {
      confirmed: [
        JSON.stringify(["eve.callerConfirmation", principalOf(alice), principalOf(person("bob"))]),
      ],
      participants: [],
    });

    const check = () =>
      contextStorage.run(ctx, () =>
        withCallIdentity(
          { confirmed: [], remembered: rememberedConfirmations(undefined, ctx) },
          () => requireCallerConfirmation("inbox", ctx),
        ),
      );

    if (released) expect(check).not.toThrow();
    else expect(check).toThrow(/until they confirm it/u);
  },
);
