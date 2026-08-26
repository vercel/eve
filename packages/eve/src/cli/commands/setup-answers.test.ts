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

  it("builds a resume command with a non-secret answer placeholder", () => {
    expect(
      headlessSetupContinuation({
        item: "channel/github",
        installed: true,
        question: { key: "phoneNumber", kind: "text", message: "Phone number?", required: true },
      }),
    ).toEqual({
      command: "eve",
      args: [
        "add",
        "channel/github",
        "--non-interactive",
        "--skip-install",
        "--answer",
        "phoneNumber=<JSON value>",
      ],
    });
  });

  it("does not put a secret answer placeholder on the command line", () => {
    expect(
      headlessSetupContinuation({
        item: "connection/linear",
        installed: true,
        question: {
          key: "apiKey",
          kind: "environment",
          message: "API key?",
          required: true,
          variable: "LINEAR_API_KEY",
          sensitive: true,
        },
      }),
    ).toEqual({
      command: "eve",
      args: ["add", "connection/linear", "--non-interactive", "--skip-install"],
    });
  });
});
