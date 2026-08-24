import { writeFile } from "node:fs/promises";
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

  it("rejects managed child resources alongside the parent selector during compilation", async () => {
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
    await expect(compileAgentManifest(discovered.manifest)).rejects.toThrow(
      /selects parent\.sandbox but has managed workspace resources/u,
    );
  });

  it("identifies only the selected sandbox backing and its external closure", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  build: { externalDependencies: ["eve", "sandbox-runtime"] },',
          "};",
          "",
        ].join("\n"),
        "agent/sandbox-helper.ts": 'export const local = "first-local";\n',
        "agent/sandbox.ts": [
          'import { external } from "sandbox-runtime";',
          'import { local } from "./sandbox-helper";',
          "export default { description: `${local}:${external}` };",
          "",
        ].join("\n"),
        "agent/tools/unrelated.ts":
          'export default { description: "first", execute() { return "first"; } };\n',
        "node_modules/sandbox-runtime/index.js": 'export const external = "first-external";\n',
        "node_modules/sandbox-runtime/package.json": JSON.stringify({
          exports: "./index.js",
          name: "sandbox-runtime",
          type: "module",
        }),
      },
      name: "sandbox-selected-backing-identity",
    });
    const compileSourceHash = async (): Promise<string> => {
      const discovered = await discoverAgent({
        agentRoot: join(app.appRoot, "agent"),
        appRoot: app.appRoot,
      });
      const manifest = await compileAgentManifest(discovered.manifest);
      if (manifest.sandbox === undefined) throw new Error("Expected a compiled sandbox.");
      return manifest.sandbox.sourceHash;
    };

    const initial = await compileSourceHash();
    await writeFile(
      join(app.appRoot, "agent", "tools", "unrelated.ts"),
      'export default { description: "second", execute() { return "second"; } };\n',
    );
    const unrelatedChange = await compileSourceHash();
    await writeFile(
      join(app.appRoot, "agent", "sandbox-helper.ts"),
      'export const local = "second-local";\n',
    );
    const relativeChange = await compileSourceHash();
    await writeFile(
      join(app.appRoot, "node_modules", "sandbox-runtime", "index.js"),
      'export const external = "second-external";\n',
    );
    const externalChange = await compileSourceHash();

    expect(unrelatedChange).toBe(initial);
    expect(relativeChange).not.toBe(unrelatedChange);
    expect(externalChange).not.toBe(relativeChange);
  });
});
