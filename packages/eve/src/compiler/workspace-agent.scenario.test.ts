import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

const rootConfig =
  "export default { model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n";
const peerConfig =
  "export default { description: 'Research product questions.', model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n";

function workspaceFiles(subagent: string) {
  return {
    "agents/research/agent/agent.ts": peerConfig,
    "agents/support/agent/agent.ts": rootConfig,
    "agents/support/agent/instructions.md": "Support users.\n",
    "agents/support/agent/subagents/research.ts": subagent,
  };
}

describe("Vercel workspace subagent compilation", () => {
  const scenarioApp = useScenarioApp();

  it("uses the addressed peer's description by default", async () => {
    const app = await scenarioApp({
      installDependencies: true,
      name: "workspace-subagent-description",
      files: workspaceFiles(
        [
          'import { defineWorkspaceAgent } from "eve";',
          'export default defineWorkspaceAgent({ path: "agents/research" });',
          "",
        ].join("\n"),
      ),
    });

    const result = await compileAgent({ startPath: join(app.appRoot, "agents", "support") });
    expect(result.manifest.remoteAgents).toEqual([
      expect.objectContaining({ description: "Research product questions.", name: "research" }),
    ]);
  });

  it("uses an authored description override", async () => {
    const app = await scenarioApp({
      installDependencies: true,
      name: "workspace-subagent-description-override",
      files: workspaceFiles(
        [
          'import { defineWorkspaceAgent } from "eve";',
          "export default defineWorkspaceAgent({",
          '  description: "Research urgent support escalations.",',
          '  path: "agents/research",',
          "});",
          "",
        ].join("\n"),
      ),
    });

    const result = await compileAgent({ startPath: join(app.appRoot, "agents", "support") });
    expect(result.manifest.remoteAgents).toEqual([
      expect.objectContaining({
        description: "Research urgent support escalations.",
        name: "research",
      }),
    ]);
  });
});
