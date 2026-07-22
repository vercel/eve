import { describe, expect, it } from "vitest";

import { Datadog } from "#evals/reporters/index.js";

describe("Datadog", () => {
  it("creates a reporter with the eval lifecycle", () => {
    const reporter = Datadog();

    expect(reporter.onRunStart).toBeTypeOf("function");
    expect(reporter.onEvalComplete).toBeTypeOf("function");
    expect(reporter.onRunComplete).toBeTypeOf("function");
  });
});
