import { describe, expect, it } from "vitest";

import { createHarnessAgentPrompt } from "#harness/harness-agent-prompt.js";

describe("createHarnessAgentPrompt", () => {
  it("combines fresh agent listings, task context, and user input without prior history", () => {
    expect(
      createHarnessAgentPrompt({
        messages: [
          { role: "assistant", content: "Earlier answer" },
          { role: "user", kind: "context.state", content: "[Agents]\n<agents />" },
          { role: "user", kind: "context.state", content: "[Task state]\ncompleted" },
          { role: "user", kind: "user", content: "What happened?" },
        ],
      }).content,
    ).toEqual([
      { type: "text", text: "[Agents]\n<agents />" },
      { type: "text", text: "\n\n" },
      { type: "text", text: "[Task state]\ncompleted" },
      { type: "text", text: "\n\n" },
      { type: "text", text: "What happened?" },
    ]);
  });

  it("keeps multimodal input parts in the fresh prompt", () => {
    const file = { type: "file" as const, data: new Uint8Array([1]), mediaType: "image/png" };
    expect(
      createHarnessAgentPrompt({
        messages: [{ role: "user", kind: "user", content: [{ type: "text", text: "See" }, file] }],
      }).content,
    ).toEqual([{ type: "text", text: "See" }, file]);
  });

  it("can continue when no new user input accompanies a step", () => {
    expect(createHarnessAgentPrompt({ messages: [] }).content).toEqual([
      { type: "text", text: "Continue the current request." },
    ]);
  });
});
