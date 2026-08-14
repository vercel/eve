import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("sandbox compilation", () => {
  const scenarioApp = useScenarioApp();

  it("preserves zero-argument sandbox definition factories", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox.ts": "export default () => ({ description: 'factory sandbox' });\n",
      },
      name: "sandbox-definition-factory",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);

    expect(manifest.sandbox).toMatchObject({
      description: "factory sandbox",
      inheritsParent: undefined,
    });
  });

  it("compiles managed child resources alongside the parent selector for runtime rejection", async () => {
    const app = await scenarioApp({
      files: {
        "agent/subagents/foo/agent.ts":
          "export default { description: 'foo', model: 'openai/gpt-5.4' };\n",
        "agent/subagents/foo/description.md": "foo\n",
        "agent/subagents/foo/sandbox/sandbox.ts": [
          'import { defineSandbox } from "eve/sandbox";',
          "export default defineSandbox((...args) => args[0].parent.sandbox);",
          "",
        ].join("\n"),
        "agent/subagents/foo/sandbox/workspace/bar.txt": "child seed\n",
      },
      installDependencies: true,
      name: "inherited-sandbox-child-resources",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    expect(manifest.subagents[0]?.agent).toMatchObject({
      sandbox: { inheritsParent: true },
      workspaceResourceRoot: { rootEntries: ["bar.txt"] },
    });
  });
});
