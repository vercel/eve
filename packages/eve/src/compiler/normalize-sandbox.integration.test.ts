import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
describe("sandbox compilation", () => {
  const createAppRoot = useTemporaryAppRoots();
  it("compiles an exported environment and selector", async () => {
    const app = await createAppRoot("eve-sandbox-environment-", {
      files: {
        "agent/sandbox.ts": [
          'import { DefaultSandbox, defineSandbox } from "eve/sandbox";',
          "export const environment = DefaultSandbox.environment();",
          "export default defineSandbox(() => environment.open());",
        ].join("\n"),
      },
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
  it("compiles managed child resources for runtime rejection", async () => {
    const app = await createAppRoot("eve-inherited-sandbox-child-resources-", {
      files: {
        "agent/subagents/foo/agent.ts":
          "export default { description: 'foo', model: 'openai/gpt-5.4' };",
        "agent/subagents/foo/description.md": "foo\n",
        "agent/subagents/foo/sandbox/sandbox.ts":
          'import { defineParentSandbox } from "eve/sandbox"; export default defineParentSandbox();',
        "agent/subagents/foo/sandbox/workspace/bar.txt": "child seed\n",
      },
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
