import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";

describe("host configuration isolation", () => {
  const scenarioApp = useScenarioApp();

  it("builds without loading the app root's Nitro config or rc file", async () => {
    const app = await scenarioApp({
      name: "host-config-isolation",
      installDependencies: true,
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Answer briefly.",
        // Either file breaks eve's host build if Nitro merges it.
        "nitro.config.ts": [
          "export default {",
          "  hooks: {",
          '    "build:before"() {',
          `      throw new Error("The app's nitro.config reached eve's host.");`,
          "    },",
          "  },",
          "};",
        ].join("\n"),
        ".nitrorc": "preset=eve-unknown-preset\n",
      },
    });
    const appRoot = await realpath(app.appRoot);

    await expect(buildApplication(appRoot, { skipSandboxPrewarm: true })).resolves.toBe(
      join(appRoot, ".output"),
    );
  });
});
