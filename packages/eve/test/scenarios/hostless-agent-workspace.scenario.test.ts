import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const require = createRequire(import.meta.url);
const vercelManifest = require("vercel/package.json") as { version: string };
const scenarioApp = useScenarioApp();

describe("hostless agent workspace", () => {
  it("assembles every direct child as a peer Vercel service", async () => {
    const app = await scenarioApp({
      files: {
        "agents/research/package.json": JSON.stringify({
          name: "@fixture/research",
          private: true,
          scripts: { build: "eve build" },
        }),
        "agents/research/agent/agent.mjs": `import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n`,
        "agents/research/agent/instructions.md": "You are the research agent.\n",
        "agents/support/package.json": JSON.stringify({
          name: "@fixture/support",
          private: true,
          dependencies: { "@fixture/shared": "workspace:*" },
          scripts: { build: "node scripts/generate.mjs && eve build" },
        }),
        "agents/support/scripts/generate.mjs": `import { writeFile } from "node:fs/promises";\nawait writeFile(new URL("../agent/generated.mjs", import.meta.url), "export default 'generated';\\n");\n`,
        "agents/support/agent/agent.mjs": `import generated from "./generated.mjs";\nimport shared from "@fixture/shared";\nif (generated + shared !== "generated shared") throw new Error("member build did not generate or resolve shared code");\nexport default { model: "openai/gpt-5.4" };\n`,
        "agents/support/agent/instructions.md": "You are the support agent.\n",
        "packages/shared/package.json": JSON.stringify({
          name: "@fixture/shared",
          private: true,
          type: "module",
          exports: "./index.mjs",
        }),
        "packages/shared/index.mjs": "export default ' shared';\n",
        ".vercel/project.json": `${JSON.stringify(
          {
            orgId: "team_eve_scenario",
            projectId: "prj_eve_collection_scenario",
            projectName: "hostless-agent-workspace",
            settings: {
              buildCommand: "pnpm exec eve build",
              framework: null,
              outputDirectory: null,
              rootDirectory: null,
            },
          },
          null,
          2,
        )}\n`,
        "pnpm-workspace.yaml":
          'packages:\n  - "agents/*"\n  - "packages/*"\nminimumReleaseAge: 0\n',
      },
      dependencies: { vercel: vercelManifest.version },
      installDependencies: true,
      name: "hostless-agent-workspace",
    });
    const packageJsonPath = join(app.appRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.eve = { agents: ["agents/*"] };
    packageJson.scripts = { build: "eve build" };
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    vi.stubEnv("VERCEL", "");
    try {
      await runPnpmCommand({ args: ["exec", "eve", "build"], cwd: app.appRoot });
      await expect(
        access(join(app.appRoot, "agents", "support", ".output", "server", "index.mjs")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(app.appRoot, "agents", "research", ".output", "server", "index.mjs")),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }

    await runPnpmCommand({ args: ["exec", "vercel", "build", "--yes"], cwd: app.appRoot });

    const outputRoot = join(app.appRoot, ".vercel", "output");
    const config = JSON.parse(await readFile(join(outputRoot, "config.json"), "utf8"));
    expect(config.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destination: { service: "eve-support", type: "service" },
          src: "^/eve/agents/support/eve/v1/(.*)$",
        }),
        expect.objectContaining({
          destination: { service: "eve-research", type: "service" },
          src: "^/eve/agents/research/eve/v1/(.*)$",
        }),
      ]),
    );
    await expect(
      access(join(outputRoot, "services", "eve-support", "functions", "__server.func")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(outputRoot, "services", "eve-research", "functions", "__server.func")),
    ).resolves.toBeUndefined();
  }, 240_000);
});
