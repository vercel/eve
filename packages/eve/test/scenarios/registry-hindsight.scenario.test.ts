import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REGISTRY_ROOT = fileURLToPath(new URL("../../../../apps/docs/", import.meta.url));
const ITEMS = ["memory/hindsight", "memory/memanto", "memory/arcana", "memory/supermemory"];

const scenarioApp = useScenarioApp();

interface RegistryItem {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly files: readonly { readonly path: string; readonly target: string }[];
}

/** `eve add` installs a bare package name at its latest release. */
function dependencyEntry(specifier: string): [string, string] {
  const separator = specifier.lastIndexOf("@");
  return separator > 0
    ? [specifier.slice(0, separator), specifier.slice(separator + 1)]
    : [specifier, "latest"];
}

describe("registry memory providers", () => {
  // https://github.com/vercel/eve/issues/4961
  it.each(ITEMS)(
    "builds the agent installed by %s",
    async (itemName) => {
      const registry = JSON.parse(await readFile(join(REGISTRY_ROOT, "registry.json"), "utf8")) as {
        readonly items: readonly RegistryItem[];
      };
      const item = registry.items.find((candidate) => candidate.name === itemName);
      if (item === undefined) throw new Error(`apps/docs/registry.json must define ${itemName}.`);

      const files: Record<string, string> = {
        "agent/agent.ts": `import { defineAgent } from "eve";\n\nexport default defineAgent({ model: "openai/gpt-5.4-mini" });\n`,
        "agent/instructions.md": "You are a helpful assistant.\n",
        "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
      };
      for (const file of item.files) {
        files[file.target] = await readFile(join(REGISTRY_ROOT, file.path), "utf8");
      }

      const app = await scenarioApp({
        dependencies: Object.fromEntries((item.dependencies ?? []).map(dependencyEntry)),
        files,
        installDependencies: true,
        name: `registry-${itemName.slice("memory/".length)}`,
      });

      // The build evaluates authored modules without calling the remote memory services.
      // Sandbox preparation is unrelated to the item and depends on the host.
      await runPnpmCommand({
        args: ["exec", "eve", "build", "--skip-sandbox-prewarm"],
        cwd: app.appRoot,
        env: {
          ...process.env,
          HINDSIGHT_API_KEY: "placeholder",
          HINDSIGHT_API_URL: "http://127.0.0.1:8888",
          MOORCHEH_API_KEY: "placeholder",
          MEMANTO_BASE_URL: "http://127.0.0.1:8888",
          ARCANA_API_KEY: "placeholder",
          ARCANA_WORKSPACE: "test-workspace",
          SUPERMEMORY_API_KEY: "placeholder",
        },
      });
    },
    300_000,
  );
});
