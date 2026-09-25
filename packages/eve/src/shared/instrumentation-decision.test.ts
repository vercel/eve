import { describe, expect, it } from "vitest";

import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";

describe("readInstrumentationDecision", () => {
  it("preserves absence and valid decisions", () => {
    expect(readInstrumentationDecision(undefined)).toBeUndefined();
    expect(
      readInstrumentationDecision({
        action: "record",
        recordInputs: false,
        recordOutputs: true,
      }),
    ).toEqual({ action: "record", recordInputs: false, recordOutputs: true });
  });

  it.each([
    null,
    { action: "record", recordInputs: "yes", recordOutputs: true },
    { action: "unknown" },
  ])("fails malformed durable state closed as drop", (value) => {
    expect(readInstrumentationDecision(value)).toEqual({ action: "drop" });
  });
});
