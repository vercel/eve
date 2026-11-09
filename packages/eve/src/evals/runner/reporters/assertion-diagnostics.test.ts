import { describe, expect, it } from "vitest";

import {
  formatAssertionFailureDetailLines,
  formatAssertionFailureHeadline,
} from "#evals/runner/reporters/assertion-diagnostics.js";
import type { AssertionResult } from "#evals/types.js";

describe("assertion failure diagnostics", () => {
  it("shows the score against its threshold and bounds verbose details", () => {
    const assertion: AssertionResult = {
      message: [`prompt: ${"x".repeat(300)}`, "one", "two", "three", "four", "five"].join("\n"),
      name: "judge.boolean [citation]",
      passed: false,
      errored: false,
      score: 0.42,
      severity: "soft",
      threshold: 0.8,
    };

    expect(formatAssertionFailureHeadline(assertion)).toMatch(
      /^judge\.boolean \[citation\] \(42% < 80%\): prompt: .+…$/u,
    );
    expect(formatAssertionFailureDetailLines(assertion)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "…",
    ]);
  });

  it("omits the score comparison when the scorer threw", () => {
    const assertion: AssertionResult = {
      message: "model unavailable",
      name: "judge.boolean",
      passed: false,
      errored: true,
      severity: "gate",
    };

    expect(formatAssertionFailureHeadline(assertion)).toBe("judge.boolean: model unavailable");
  });
});
