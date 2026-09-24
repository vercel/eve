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
          'export default defineWorkspaceAgent({ name: "research" });',
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
          '  name: "research",',
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

  it("uses the workspace member root for background workflow tool ids", async () => {
    const app = await scenarioApp({
      files: {
        "agents/assistant/agent/agent.ts": rootConfig,
        "agents/assistant/agent/instructions.md": "Call the probe tool.\n",
        "agents/assistant/agent/tools/probe.ts": [
          'import { defineWorkflowTool } from "eve/tools";',
          "",
          "export default defineWorkflowTool({",
          '  description: "Probe the workflow registry.",',
          '  execution: "background",',
          "  inputSchema: {},",
          "  async execute() {",
          '    "use workflow";',
          '    return { status: "ok" };',
          "  },",
          "});",
          "",
        ].join("\n"),
      },
      installDependencies: true,
      name: "workspace-member-background-workflow-id",
    });

    const result = await compileAgent({ startPath: join(app.appRoot, "agents", "assistant") });

    expect(result.manifest.tools.find((tool) => tool.name === "probe")?.behavior).toMatchObject({
      handling: {
        kind: "workflow-tool",
        workflowId: "workflow//./agent/tools/probe//execute",
      },
    });
  });

  it("rejects an unknown peer even with a description override", async () => {
    const app = await scenarioApp({
      installDependencies: true,
      name: "workspace-subagent-unknown-peer",
      files: workspaceFiles(
        [
          'import { defineWorkspaceAgent } from "eve";',
          "export default defineWorkspaceAgent({",
          '  description: "Research urgent support escalations.",',
          '  name: "missing",',
          "});",
          "",
        ].join("\n"),
      ),
    });

    await expect(
      compileAgent({ startPath: join(app.appRoot, "agents", "support") }),
    ).rejects.toThrow('targets unknown workspace member "missing"');
  });
});
