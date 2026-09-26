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

  it("omits agent messaging instructions when subagents are unavailable", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: false,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Agent messaging"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });
});
