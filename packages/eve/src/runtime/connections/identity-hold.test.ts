import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";

const bob: SessionAuthContext = {
  attributes: {},
  authenticator: "vercel-oidc",
  principalId: "user_bob",
  principalType: "user",
};

describe("model call mark across module copies", () => {
  it("a call marked by one copy is held by another copy", async () => {
    vi.resetModules();
    const copyA = await import("#runtime/connections/identity-hold.js");

    vi.resetModules();
    const copyB = await import("#runtime/connections/identity-hold.js");
    const { ContextContainer, contextStorage } = await import("#context/container.js");
    const { SteeredByKey } = await import("#context/keys.js");

    const ctx = new ContextContainer();
    ctx.set(SteeredByKey, [bob]);

    expect(contextStorage.run(ctx, () => copyB.steeredModelCall())).toBe(false);
    expect(contextStorage.run(ctx, () => copyA.withModelCall(() => copyB.steeredModelCall()))).toBe(
      true,
    );
  });
});
