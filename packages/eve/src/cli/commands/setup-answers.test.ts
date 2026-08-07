import { describe, expect, it } from "vitest";

import { parseSetupAnswer } from "./setup-answers.js";
import { headlessSetupContinuation } from "./setup-headless.js";

describe("setup answers", () => {
  it("accumulates JSON values", () => {
    const first = parseSetupAnswer('mode="portable"');
    const answers = parseSetupAnswer('events=["issues","pull_request"]', first);

    expect(answers).toEqual({ mode: "portable", events: ["issues", "pull_request"] });
  });

  it("rejects unquoted string values", () => {
    expect(() => parseSetupAnswer("mode=portable")).toThrow("must be JSON");
  });

  it("builds a minimal resume command", () => {
    expect(headlessSetupContinuation({ item: "channel/github", installed: true })).toEqual({
      command: "eve",
      args: ["add", "channel/github", "--non-interactive", "--skip-install"],
    });
  });
});
