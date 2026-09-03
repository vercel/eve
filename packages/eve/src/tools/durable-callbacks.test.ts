import { describe, expect, it } from "vitest";

import {
  hasUnregisteredDurableDynamicCallbacks,
  registerDurableDynamicCallback,
  type DurableDynamicCallbackPhase,
} from "#tools/durable-callbacks.js";

const reference = { closure: {} };

describe("hasUnregisteredDurableDynamicCallbacks", () => {
  it("checks nested activity references by their registry phases", () => {
    const name = "nested-activity-registration-test";
    const phases: DurableDynamicCallbackPhase[] = [
      "execute",
      "activityComplete",
      "activityDelta",
      "activityStart",
    ];
    for (const phase of phases) {
      registerDurableDynamicCallback({ callback: () => undefined, phase, toolName: name });
    }

    expect(
      hasUnregisteredDurableDynamicCallbacks([
        {
          callbacks: {
            activity: {
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

  it("detects a missing nested activity phase", () => {
    const name = "missing-nested-activity-registration-test";
    registerDurableDynamicCallback({
      callback: () => undefined,
      phase: "execute",
      toolName: name,
    });

    expect(
      hasUnregisteredDurableDynamicCallbacks([
        {
          callbacks: { activity: { delta: reference }, execute: reference },
          name,
        },
      ]),
    ).toBe(true);
  });
});
