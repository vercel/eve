import { expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { AuthKey, SenderAuthKey } from "#context/keys.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  identityRequestOf,
  requireCallerConfirmation,
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
