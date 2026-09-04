import { describe, expect, it } from "vitest";

import {
  hasUnregisteredDurableDynamicCallbacks,
  registerDurableDynamicCallback,
  type DurableDynamicCallbackPhase,
} from "#tools/durable-callbacks.js";

const reference = { closure: {} };

describe("hasUnregisteredDurableDynamicCallbacks", () => {
  it("checks nested label references by their registry phases", () => {
    const name = "nested-label-registration-test";
    const phases: DurableDynamicCallbackPhase[] = [
      "execute",
      "labelComplete",
      "labelDelta",
      "labelStart",
    ];
    for (const phase of phases) {
      registerDurableDynamicCallback({ callback: () => undefined, phase, toolName: name });
    }

    expect(
      hasUnregisteredDurableDynamicCallbacks([
        {
          callbacks: {
            label: {
              complete: reference,
              delta: reference,
              start: reference,
            },
            execute: reference,
          },
          name,
        },
      ]),
    ).toBe(false);
  });

  it("detects a missing nested label phase", () => {
    const name = "missing-nested-label-registration-test";
    registerDurableDynamicCallback({
      callback: () => undefined,
      phase: "execute",
      toolName: name,
    });

    expect(
      hasUnregisteredDurableDynamicCallbacks([
        {
          callbacks: { label: { delta: reference }, execute: reference },
          name,
        },
      ]),
    ).toBe(true);
  });
});
