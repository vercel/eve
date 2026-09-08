import { describe, expect, it } from "vitest";

import {
  clearDurableDynamicCallbacks,
  hasUnregisteredDurableDynamicCallbacks,
  registerDurableDynamicCallback,
  type DurableDynamicCallbackPhase,
  type DynamicToolCallbackOwner,
} from "#tools/durable-callbacks.js";

const reference = { closure: {} };

function owner(name: string): DynamicToolCallbackOwner {
  return {
    entryKey: name,
    name,
    resolverSlug: "test",
    scope: "session",
    sessionId: name,
  };
}

describe("hasUnregisteredDurableDynamicCallbacks", () => {
  it("checks nested label references by their registry phases", () => {
    const callbackOwner = owner("nested-label-registration-test");
    const phases: DurableDynamicCallbackPhase[] = [
      "execute",
      "labelComplete",
      "labelDelta",
      "labelStart",
    ];
    for (const phase of phases) {
      registerDurableDynamicCallback({ callback: () => undefined, phase, owner: callbackOwner });
    }

    expect(
      hasUnregisteredDurableDynamicCallbacks(
        [
          {
            callbacks: {
              label: { complete: reference, delta: reference, start: reference },
              execute: reference,
            },
            entryKey: callbackOwner.entryKey,
            name: callbackOwner.name,
            resolverSlug: callbackOwner.resolverSlug,
          },
        ],
        { scope: callbackOwner.scope, sessionId: callbackOwner.sessionId },
      ),
    ).toBe(false);
    clearDurableDynamicCallbacks(callbackOwner.sessionId);
  });

  it("detects a missing nested label phase", () => {
    const callbackOwner = owner("missing-nested-label-registration-test");
    registerDurableDynamicCallback({
      callback: () => undefined,
      owner: callbackOwner,
      phase: "execute",
    });

    expect(
      hasUnregisteredDurableDynamicCallbacks(
        [
          {
            callbacks: { execute: reference, label: { delta: reference } },
            entryKey: callbackOwner.entryKey,
            name: callbackOwner.name,
            resolverSlug: callbackOwner.resolverSlug,
          },
        ],
        { scope: callbackOwner.scope, sessionId: callbackOwner.sessionId },
      ),
    ).toBe(true);
    clearDurableDynamicCallbacks(callbackOwner.sessionId);
  });
});
