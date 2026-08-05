import { describe, expect, it } from "vitest";

import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("includes agent messaging instructions when subagents are available and persistent sessions are enabled", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).toContainEqual(expect.stringContaining("<agents>"));
  });

  it("omits agent messaging instructions when persistent sessions are not enabled", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });

  it("omits agent messaging instructions when subagents are unavailable", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: false,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });
});
