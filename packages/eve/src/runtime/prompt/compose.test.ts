import { describe, expect, it } from "vitest";

import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("includes agent messaging instructions when subagents are available and persistent sessions are enabled", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(expect.stringContaining("agentId"));
    expect(prompt).toContainEqual(expect.stringContaining("<agents>"));
  });

  it("omits agent messaging instructions when persistent sessions are not enabled", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });

  it("describes task-mode background work and notifications", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: true,
      tasksEnabled: true,
    });

    expect(prompt).toContainEqual(
      expect.stringContaining(
        "Subagent calls start durable background tasks and proceed independently.\nEach task will notify you",
      ),
    );
    expect(prompt).toContainEqual(expect.stringContaining("task's result"));
    expect(prompt).not.toContainEqual(expect.stringContaining("task_peek"));
    expect(prompt).not.toContainEqual(expect.stringContaining("task_sleep"));
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
