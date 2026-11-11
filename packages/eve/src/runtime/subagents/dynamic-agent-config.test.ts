import { describe, expect, it } from "vitest";

import { defineAgent } from "#public/definitions/agent.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

describe("normalizeDynamicSubagentAgentConfig", () => {
  it("rejects a plain object that did not come from defineAgent()", async () => {
    await expect(
      normalizeDynamicSubagentAgentConfig({
        modelMetadata: undefined as never,
        name: "researcher",
        state: {} as never,
        value: { description: "Perform deep research.", model: "openai/gpt-5.5" },
      }),
    ).rejects.toThrow(
      'Dynamic subagent "researcher" must return defineAgent(...), defineRemoteAgent(...), or null. Wrap a returned agent object in defineAgent({...}) from "eve".',
    );
  });

  it("rejects a selected limits.sessionUsage", async () => {
    await expect(
      normalizeDynamicSubagentAgentConfig({
        modelMetadata: undefined as never,
        name: "researcher",
        state: {} as never,
        value: defineAgent({
          description: "Perform deep research.",
          limits: { sessionUsage: () => true },
          model: "openai/gpt-5.5",
        }),
      }),
    ).rejects.toThrow(
      'The "limits.sessionUsage" field cannot be selected at runtime; the root agent\'s `sessionUsage` applies.',
    );
  });
});
