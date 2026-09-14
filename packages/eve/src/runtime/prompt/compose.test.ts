import { describe, expect, it } from "vitest";

import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("includes agent messaging instructions when subagents are available", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(expect.stringContaining("agentId"));
    expect(prompt).toContainEqual(expect.stringContaining("<agents>"));
  });

  it("instructs parents to rely on notifications instead of polling", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(
      expect.stringContaining("return immediately with a task receipt"),
    );
    expect(prompt).toContainEqual(
      expect.stringContaining("notifications include the task's result"),
    );
    expect(prompt).not.toContainEqual(expect.stringContaining("task_peek"));
    expect(prompt).not.toContainEqual(expect.stringContaining("task_sleep"));
    expect(prompt).toContainEqual(expect.stringContaining("notify you"));
  });

  it("omits agent messaging instructions when subagents are unavailable", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: false,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });
});
