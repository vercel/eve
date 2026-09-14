import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
describe("sandbox compilation", () => {
  const scenarioApp = useScenarioApp();
  it("compiles an exported environment and selector", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox.ts": [
          'import { DefaultSandbox, defineSandbox } from "eve/sandbox";',
          "export const environment = DefaultSandbox.environment();",
          "export default defineSandbox(() => environment.create());",
        ].join("\n"),
      },
      installDependencies: true,
      name: "sandbox-environment",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    expect(manifest.sandbox).toMatchObject({
      environmentExportName: "environment",
      inheritsParent: undefined,
    });
  });
  it("captures a colocated Dockerfile in the environment generation", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox/Dockerfile": "FROM alpine:3.21\n",
        "agent/sandbox/sandbox.ts": [
          'import { defineSandbox } from "eve/sandbox";',
          'import { DockerSandbox } from "eve/sandbox/docker";',
          "export const environment = DockerSandbox.dockerfile();",
          "export default defineSandbox(() => environment.create());",
        ].join("\n"),
      },
      installDependencies: true,
      name: "sandbox-dockerfile-environment",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    expect(manifest.sandbox).toMatchObject({
      providerName: "docker",
      dockerfileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      environmentExportName: "environment",
    });
  });

  it("compiles managed child resources for runtime rejection", async () => {
    const app = await scenarioApp({
      files: {
        "agent/subagents/foo/agent.ts":
          "export default { description: 'foo', model: 'openai/gpt-5.4' };",
        "agent/subagents/foo/description.md": "foo\n",
        "agent/subagents/foo/sandbox/sandbox.ts":
          'import { defineParentSandbox } from "eve/sandbox"; export default defineParentSandbox();',
        "agent/subagents/foo/sandbox/workspace/bar.txt": "child seed\n",
      },
      installDependencies: true,
      name: "inherited-sandbox-child-resources",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const child = (await compileAgentManifest(discovered.manifest)).subagents[0]!.agent;
    expect(child).toMatchObject({
      sandbox: { inheritsParent: true },
      workspaceResourceRoot: { rootEntries: ["bar.txt"] },
    });
  });
});
