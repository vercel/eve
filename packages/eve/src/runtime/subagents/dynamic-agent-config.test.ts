import { describe, expect, it } from "vitest";

import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

describe("normalizeDynamicSubagentAgentConfig", () => {
  it("rejects a selected limits.sessionUsage", async () => {
    await expect(
      normalizeDynamicSubagentAgentConfig({
        name: "researcher",
        state: {} as never,
        value: {
          description: "Perform deep research.",
          limits: { sessionUsage: () => true },
          model: "openai/gpt-5.5",
        },
      }),
    ).rejects.toThrow(
      'The "limits.sessionUsage" field cannot be selected at runtime; the root agent\'s `sessionUsage` applies.',
    );
  });
});
