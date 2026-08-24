import { describe, expect, it } from "vitest";

import {
  clearDurableDynamicCallbacksForSession,
  hasUnregisteredDurableDynamicCallbacks,
  lookupDurableDynamicCallback,
  registerDurableDynamicCallback,
} from "#shared/durable-dynamic-tool-callbacks.js";

describe("durable dynamic callback registry", () => {
  it("does not reuse the incompatible pre-v2 global registry shape", () => {
    const legacyRegistry = new Map([["reload-test", new Map([["execute", () => "old-shape"]])]]);
    const legacySymbol = Symbol.for("eve:dynamic-tool-callbacks");
    Reflect.set(globalThis, legacySymbol, legacyRegistry);
    const callback = () => "v2";

    registerDurableDynamicCallback({
      callback,
      phase: "execute",
      toolName: "reload-test",
    });

    expect(lookupDurableDynamicCallback("reload-test", "execute")).toBe(callback);
    Reflect.deleteProperty(globalThis, legacySymbol);
  });

  it("keeps distinct keyed registrations isolated under the same name and phase", () => {
    const first = () => "first";
    const second = () => "second";

    registerDurableDynamicCallback({
      callback: first,
      phase: "execute",
      registrationKey: "collision-test:first",
      toolName: "collision-test",
    });

    registerDurableDynamicCallback({
      callback: second,
      phase: "execute",
      registrationKey: "collision-test:second",
      toolName: "collision-test",
    });
    expect(lookupDurableDynamicCallback("collision-test", "execute", "collision-test:first")).toBe(
      first,
    );
    expect(lookupDurableDynamicCallback("collision-test", "execute", "collision-test:second")).toBe(
      second,
    );
    expect(lookupDurableDynamicCallback("collision-test", "execute")).toBeUndefined();
    expect(
      hasUnregisteredDurableDynamicCallbacks([
        {
          callbacks: {
            execute: { closure: {}, registrationKey: "collision-test:second" },
          },
          name: "collision-test",
        },
      ]),
    ).toBe(false);
  });

  it("rejects ambiguous legacy registrations without replacing the first callback", () => {
    const first = () => "first";
    registerDurableDynamicCallback({
      callback: first,
      phase: "execute",
      toolName: "legacy-collision-test",
    });

    expect(() =>
      registerDurableDynamicCallback({
        callback: () => "second",
        phase: "execute",
        toolName: "legacy-collision-test",
      }),
    ).toThrow(/multiple implementations/);
    expect(lookupDurableDynamicCallback("legacy-collision-test", "execute")).toBe(first);
  });

  it("replaces the callback when the same registration is rebound", () => {
    const first = () => "first";
    const second = () => "second";

    registerDurableDynamicCallback({
      callback: first,
      phase: "execute",
      registrationKey: "rebind-test:execute",
      toolName: "rebind-test",
    });
    registerDurableDynamicCallback({
      callback: second,
      phase: "execute",
      registrationKey: "rebind-test:execute",
      toolName: "rebind-test",
    });

    expect(lookupDurableDynamicCallback("rebind-test", "execute", "rebind-test:execute")).toBe(
      second,
    );
  });

  it("releases session-owned callbacks when the session completes", () => {
    const callback = () => "owned";
    registerDurableDynamicCallback({
      callback,
      owner: "cleanup-session",
      phase: "execute",
      registrationKey: "cleanup-session:execute",
      toolName: "cleanup-test",
    });
    expect(
      lookupDurableDynamicCallback(
        "cleanup-test",
        "execute",
        "cleanup-session:execute",
        "cleanup-session",
      ),
    ).toBe(callback);

    clearDurableDynamicCallbacksForSession("cleanup-session");

    expect(
      lookupDurableDynamicCallback(
        "cleanup-test",
        "execute",
        "cleanup-session:execute",
        "cleanup-session",
      ),
    ).toBeUndefined();
  });

  it("treats legacy metadata without a registration key as unbound", () => {
    expect(
      hasUnregisteredDurableDynamicCallbacks([
        { callbacks: { execute: { closure: {} } }, name: "legacy-test" },
      ]),
    ).toBe(true);
  });
});
