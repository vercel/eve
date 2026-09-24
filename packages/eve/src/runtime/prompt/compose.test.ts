import { describe, expect, it } from "vitest";

import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("includes agent messaging instructions when subagents are available", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(expect.stringContaining("agentId"));
    expect(prompt).toContainEqual(expect.stringContaining("`[Tasks]`"));
    expect(prompt).toContainEqual(expect.stringContaining("<idle_agents>"));
  });

  it("describes subagent calls as waiting for the answer unless they return a receipt", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(
      expect.stringContaining("waits for the agent to answer, and its answer is the tool result"),
    );
    expect(prompt).toContainEqual(
      expect.stringContaining("its answer arrives later in a <task_result> message"),
    );
    expect(prompt).not.toContainEqual(expect.stringContaining("task receipt"));
    expect(prompt).not.toContainEqual(expect.stringContaining("task_peek"));
    expect(prompt).not.toContainEqual(expect.stringContaining("task_sleep"));
  });

  it("omits agent messaging instructions when subagents are unavailable", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: false,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("agentId"));
    expect(prompt).not.toContainEqual(expect.stringContaining("[Tasks]"));
  });
});
