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

it('with callerConfirmation "once", asks the caller without remembering an approval after someone anonymous', () => {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: {
      nodesByNodeId: new Map([["__root__", { agent: { config: { callerConfirmation: "once" } } }]]),
    },
  } as never);
  ctx.set(AuthKey, alice);
  ctx.set(SenderAuthKey, { ...alice, principalId: "anon-1", principalType: "anonymous" });

  let refusal: unknown;
  try {
    requireCallerConfirmation("inbox", ctx);
  } catch (error) {
    refusal = error;
  }

  // Every anonymous person shares one identity, so an approval after one would cover them all.
  const request = identityRequestOf(refusal);
  expect(request).toMatchObject({ person: { principalId: "alice" } });
  expect(request?.remember).toBeUndefined();
});
