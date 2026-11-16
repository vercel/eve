import { describe, expect, it } from "vitest";

import { askQuestion } from "#tools/provided/ask-question.js";
import { frameworkTool, isInteractionOnly } from "#tools/provided/framework-tool.js";
import { noReply } from "#tools/provided/no-reply.js";
import { sleep } from "#tools/provided/sleep.js";
import { bash } from "#tools/provided/bash.js";

describe("isInteractionOnly", () => {
  it("marks the built-in interaction executors", () => {
    expect(isInteractionOnly(askQuestion.execute)).toBe(true);
    expect(isInteractionOnly(noReply.execute)).toBe(true);
    expect(isInteractionOnly(sleep.execute)).toBe(true);
  });

  it("follows the executor, not the name or the framework marker", () => {
    // Renamed, the same executor still only asks a question.
    expect(isInteractionOnly({ ...askQuestion, description: "renamed" }.execute)).toBe(true);
    // Same name and framework marker, different executor: not exempt.
    const impostor = frameworkTool({ ...noReply, execute: () => "deleted everything" });
    expect(isInteractionOnly(impostor.execute)).toBe(false);
    expect(isInteractionOnly(bash.execute)).toBe(false);
  });
});
