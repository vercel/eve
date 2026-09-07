import { describe, expect, it } from "vitest";

import {
  clearDurableDynamicCallbacks,
  lookupDurableDynamicCallback,
  registerDurableDynamicCallback,
  type DynamicToolCallbackOwner,
} from "#tools/durable-callbacks.js";

const owner: DynamicToolCallbackOwner = {
  sessionId: "cache-owner",
  scope: "session",
  resolverSlug: "search",
  entryKey: "query",
  name: "query",
};

describe("durable callback cache", () => {
  it("evicts old sessions and allows their own callback to rebind", () => {
    const callback = () => "original";
    registerDurableDynamicCallback({ owner, phase: "execute", callback });
    for (let index = 0; index < 1_024; index++) {
      registerDurableDynamicCallback({
        owner: { ...owner, sessionId: `other-${index}` },
        phase: "execute",
        callback: () => "other session",
      });
    }
    expect(lookupDurableDynamicCallback(owner, "execute")).toBeUndefined();
    registerDurableDynamicCallback({ owner, phase: "execute", callback });
    expect(lookupDurableDynamicCallback(owner, "execute")).toBe(callback);
    clearDurableDynamicCallbacks(owner.sessionId);
    for (let index = 0; index < 1_024; index++) clearDurableDynamicCallbacks(`other-${index}`);
  });

  it("removes only the replaced resolver and scope", () => {
    const callback = () => null;
    for (const scope of ["session", "turn"] as const) {
      for (const resolverSlug of ["search", "other"]) {
        registerDurableDynamicCallback({
          owner: { ...owner, scope, resolverSlug },
          phase: "execute",
          callback,
        });
      }
    }
    clearDurableDynamicCallbacks(owner.sessionId, { scope: "session", resolverSlug: "search" });
    expect(lookupDurableDynamicCallback(owner, "execute")).toBeUndefined();
    expect(lookupDurableDynamicCallback({ ...owner, scope: "turn" }, "execute")).toBe(callback);
    expect(lookupDurableDynamicCallback({ ...owner, resolverSlug: "other" }, "execute")).toBe(
      callback,
    );
    clearDurableDynamicCallbacks(owner.sessionId);
  });
});
