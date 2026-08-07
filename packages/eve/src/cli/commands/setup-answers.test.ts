import { describe, expect, it } from "vitest";

import { parseSetupAnswer } from "./setup-answers.js";
import { headlessSetupContinuation } from "./setup-headless.js";

describe("setup answers", () => {
  it("accumulates strings and JSON values", () => {
    const first = parseSetupAnswer("mode=portable");
    const answers = parseSetupAnswer('events=["issues","pull_request"]', first);

    expect(answers).toEqual({ mode: "portable", events: ["issues", "pull_request"] });
  });

  it("builds a minimal resume command", () => {
    expect(headlessSetupContinuation({ item: "channel/github", installed: true })).toBe(
      "eve add channel/github --headless --skip-install",
    );
  });
});
