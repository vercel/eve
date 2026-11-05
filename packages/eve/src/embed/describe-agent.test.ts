import { describe, expect, it } from "vitest";

import { codeAgentOf } from "#embed/agent.js";
import { eve } from "#definitions/defaults.js";
import { defineAgent } from "#public/definitions/agent.js";
import { describeAgent } from "#embed/describe-agent.js";
import { hostSandbox } from "#runtime/sandbox/host-sandbox.js";

describe("describeAgent's sandbox", () => {
  it("names the definition the agent's sessions open their sandbox from, under any id", async () => {
    const workbench = defineAgent({
      definitions: [
        {
          contribute: () => ({}),
          id: "workbench",
          label: "workbench.ts",
          resources: { sandbox: hostSandbox() },
        },
      ],
      model: "openai/gpt-5",
    });
    expect(await codeAgentOf(workbench).sandbox()).toBeDefined();
    expect(await describeAgent(codeAgentOf(workbench))).toContain("Sandbox: from workbench.ts");
  });

  it("names the preset's sandbox, and none when the agent has no sandbox", async () => {
    const preset = defineAgent({ definitions: eve.defaults(), model: "openai/gpt-5" });
    expect(await describeAgent(codeAgentOf(preset))).toContain("Sandbox: from sandbox.ts");
    const bare = defineAgent({ model: "openai/gpt-5" });
    expect(await describeAgent(codeAgentOf(bare))).toContain("Sandbox: none");
  });
});
