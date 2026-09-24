import { describe, expect, it } from "vitest";

import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("leaves task instructions to the harness, which offers them with the task tools", () => {
    const prompt = composeRuntimeBasePrompt({ toolsAvailable: true });

    expect(prompt).toContainEqual(expect.stringContaining("Tool execution"));
    expect(prompt).not.toContainEqual(expect.stringContaining("agentId"));
    expect(prompt).not.toContainEqual(expect.stringContaining("[Tasks]"));
    expect(prompt).not.toContainEqual(expect.stringContaining("task_wait"));
  });
});
