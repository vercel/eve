import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("materializeScenarioApp", () => {
  const scenarioApp = useScenarioApp();

  it("writes declared files under the generated app root", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "System prompt.\n",
      },
      name: "minimal-app",
    });

    const agentSource = await readFile(join(app.appRoot, "agent/agent.ts"), "utf8");
    const systemSource = await readFile(join(app.appRoot, "agent/instructions.md"), "utf8");

    expect(agentSource).toContain('model: "openai/gpt-5.4"');
    expect(systemSource).toBe("System prompt.\n");
  });

  it("writes a package.json wiring the packed eve tarball", async () => {
    const app = await scenarioApp({
      files: {},
      name: "manifest-only-app",
    });

    const manifestSource = await readFile(join(app.appRoot, "package.json"), "utf8");
    const manifest = JSON.parse(manifestSource) as {
      dependencies: Record<string, string>;
      name: string;
      type: string;
    };

    expect(manifest.name).toBe("manifest-only-app");
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies["eve"]).toMatch(/^file:\.\/eve-.*\.tgz$/);
  });

  it("creates declared empty directories", async () => {
    const app = await scenarioApp({
      directories: ["agent/tools", "agent/skills"],
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
      },
      name: "empty-directories-app",
    });

    const toolsStat = await stat(join(app.appRoot, "agent/tools"));
    const skillsStat = await stat(join(app.appRoot, "agent/skills"));

    expect(toolsStat.isDirectory()).toBe(true);
    expect(skillsStat.isDirectory()).toBe(true);
  });

  it("installs dependencies into node_modules when requested", async () => {
    const app = await scenarioApp({
      dependencies: {
        zod: "^4.3.6",
      },
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
      },
      installDependencies: true,
      name: "install-deps-app",
    });

    const eveManifestPath = join(app.appRoot, "node_modules", "eve", "package.json");
    const zodManifestPath = join(app.appRoot, "node_modules", "zod", "package.json");

    const eveManifestStat = await stat(eveManifestPath);
    const zodManifestStat = await stat(zodManifestPath);

    expect(eveManifestStat.isFile()).toBe(true);
    expect(zodManifestStat.isFile()).toBe(true);
  }, 60_000);
});
