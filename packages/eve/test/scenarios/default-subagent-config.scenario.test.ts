import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("default local subagent config", () => {
  const scenarioApp = useScenarioApp();

  it("reaches the canonical config source before rejecting a missing description", async () => {
    const app = await scenarioApp({
      files: {
        "agent/instructions.md": "Delegate research when useful.\n",
        "agent/subagents/researcher/instructions.md": "Research the assigned question.\n",
      },
      name: "default-local-subagent-config",
    });

    await expect(compileAgent({ startPath: app.appRoot })).rejects.toThrow(
      'Local subagent "subagents/researcher" requires a model-visible "description". Author its `agent.ts` with `defineAgent({ description, model })` so the parent agent can decide when to delegate to this subagent.',
    );
  });
});
