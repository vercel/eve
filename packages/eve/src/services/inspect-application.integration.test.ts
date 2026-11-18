import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION } from "#compiler/extension-compatibility.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { inspectApplication } from "#services/inspect-application.js";
import { readCachedCompile, resolveInspectCachePath } from "#services/inspect-cache.js";

const MODEL = 'model: "openai/gpt-5.5", modelContextWindowTokens: 200000';
const ENV_NAMES = ["INSPECT_CACHE_TEST_LABEL", "NODE_OPTIONS"] as const;

function tool(description: string, lib = "../../lib/label.ts"): string {
  return `import { label } from "${lib}";\nexport default { description: ${description}, execute: () => null };\n`;
}

async function backdate(directory: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".eve" || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await backdate(path);
    await utimes(path, past, past);
  }
}

describe("inspectApplication cache", () => {
  const createAppRoot = useTemporaryAppRoots();
  const previousEnv = ENV_NAMES.map((name) => process.env[name]);

  afterEach(() => {
    ENV_NAMES.forEach((name, index) => {
      if (previousEnv[index] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[index];
    });
  });

  async function createApp(files: Readonly<Record<string, string>> = {}) {
    const app = await createAppRoot("eve-inspect-cache-", {
      files: {
        ".eve/cache/model-catalog.json": JSON.stringify({
          fetchedAt: new Date(Date.now() + 3_600_000).toISOString(),
          kind: "eve-model-catalog-cache",
          models: [],
          providerAliases: {},
          version: 2,
        }),
        "agent/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ ${MODEL} });\n`,
        "agent/instructions.md": "Answer briefly.\n",
        "agent/tools/lookup.ts": tool("label"),
        "lib/label.ts": 'export const label = "first";\n',
        ...files,
      },
    });
    await backdate(app.appRoot);
    return app.appRoot;
  }

  async function inspect(appRoot: string, cache: "read" | "refresh" = "read") {
    const { compiledState } = await inspectApplication(appRoot, { cache });
    return { compiledState: compiledState!, compiledAt: await compiledAt(appRoot) };
  }

  async function compiledAt(appRoot: string) {
    return (await stat(join(appRoot, ".eve", "compile", "compiled-agent-manifest.json"))).mtimeMs;
  }

  it("reuses a large project's compile until a file changes or refresh is asked", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1) {
      files[`agent/tools/tool_${index}.ts`] = tool(`label + " ${index}"`);
      files[`agent/skills/skill-${index}.md`] =
        `---\nname: skill-${index}\ndescription: Skill ${index}.\n---\n\nDo ${index}.\n`;
    }
    for (let index = 0; index < 15; index += 1) {
      const root = `agent/subagents/helper-${index}`;
      files[`${root}/agent.ts`] =
        `import { defineAgent } from "eve";\nexport default defineAgent({ description: "Helper ${index}.", ${MODEL} });\n`;
      files[`${root}/tools/lookup.ts`] = tool("label", "../../../../lib/label.ts");
    }
    const appRoot = await createApp(files);

    const first = await inspect(appRoot);
    const second = await inspect(appRoot);
    expect(second.compiledAt).toBe(first.compiledAt);
    expect(second.compiledState).toEqual(JSON.parse(JSON.stringify(first.compiledState)));
    expect(first.compiledState.manifest.subagents).toHaveLength(15);

    expect((await inspect(appRoot, "refresh")).compiledAt).not.toBe(first.compiledAt);

    await writeFile(
      join(appRoot, "agent/subagents/helper-9/tools/lookup.ts"),
      'export default { description: "changed", execute: () => null };\n',
    );
    const helper = (await inspect(appRoot)).compiledState.manifest.subagents.find(
      ({ name }) => name === "helper-9",
    );
    expect(helper?.agent.tools.find(({ name }) => name === "lookup")?.description).toBe("changed");
  }, 120_000);

  it("caches a compile that runs right after an edit", async () => {
    const appRoot = await createApp();
    await writeFile(join(appRoot, "lib/label.ts"), 'export const label = "edited";\n');

    await inspect(appRoot);

    expect(await readCachedCompile(appRoot)).not.toBeNull();
  });

  const extension = {
    "agent/extensions/crm.mjs": 'import ext from "@acme/crm"; export default ext;\n',
    "node_modules/@acme/crm/package.json": JSON.stringify({
      name: "@acme/crm",
      type: "module",
      eve: { extension: { source: "source", dist: "extension" } },
      exports: { ".": "./extension/extension.mjs" },
    }),
    "node_modules/@acme/crm/extension/_manifest.json": JSON.stringify({
      kind: "eve-extension",
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.0.0",
      contractMajor: 0,
    }),
    "node_modules/@acme/crm/extension/extension.mjs": 'export default { name: "crm" };\n',
    "node_modules/@acme/crm/extension/skills/lookup.md":
      "---\nname: lookup\ndescription: Look up accounts.\n---\n\nLook them up.\n",
  };

  it.each<[string, Record<string, string>, (appRoot: string) => Promise<void>]>([
    [
      "a module outside the agent directory",
      {},
      (appRoot) => writeFile(join(appRoot, "lib/label.ts"), 'export const label = "second";\n'),
    ],
    [
      "an environment variable a module reads",
      { "agent/tools/lookup.ts": tool('process.env.INSPECT_CACHE_TEST_LABEL ?? "unset"') },
      async () => {
        process.env.INSPECT_CACHE_TEST_LABEL = "second";
      },
    ],
    [
      "a module's package manifest",
      { "lib/package.json": '{ "type": "module" }' },
      (appRoot) =>
        writeFile(
          join(appRoot, "lib/package.json"),
          '{ "type": "module", "exports": "./label.ts" }',
        ),
    ],
    [
      "a path alias config",
      { "jsconfig.json": "{}" },
      (appRoot) =>
        writeFile(join(appRoot, "jsconfig.json"), '{ "compilerOptions": { "paths": {} } }'),
    ],
    [
      "a config that tsconfig.json extends",
      {
        "tsconfig.json": '{ "extends": "@acme/tsconfig/base.json" }',
        "node_modules/@acme/tsconfig/package.json": '{ "name": "@acme/tsconfig" }',
        "node_modules/@acme/tsconfig/base.json": "{}",
      },
      (appRoot) =>
        writeFile(
          join(appRoot, "node_modules/@acme/tsconfig/base.json"),
          '{ "compilerOptions": { "paths": {} } }',
        ),
    ],
    [
      "the Node.js conditions",
      {},
      async () => {
        process.env.NODE_OPTIONS = "--conditions=inspect-cache-test";
      },
    ],
    [
      "a mounted extension's files",
      extension,
      (appRoot) =>
        writeFile(
          join(appRoot, "node_modules/@acme/crm/extension/skills/audit.md"),
          "---\nname: audit\ndescription: Audit accounts.\n---\n\nAudit them.\n",
        ),
    ],
  ])("misses the cache after a change to %s", async (_, files, change) => {
    const appRoot = await createApp(files);
    await inspect(appRoot);
    expect(await readCachedCompile(appRoot)).not.toBeNull();

    await change(appRoot);

    expect(await readCachedCompile(appRoot)).toBeNull();
  });

  it.each([
    'process.env["INSPECT_" + "CACHE_TEST_LABEL"]',
    'process["env"].INSPECT_CACHE_TEST_LABEL',
    "process?.env.INSPECT_CACHE_TEST_LABEL",
    "(({ INSPECT_CACHE_TEST_LABEL }) => INSPECT_CACHE_TEST_LABEL)(process.env)",
    "(() => { const { env } = process; return env.INSPECT_CACHE_TEST_LABEL; })()",
  ])("does not cache a compile whose modules read %s", async (read) => {
    const appRoot = await createApp({ "agent/tools/lookup.ts": tool(`${read} ?? label`) });

    const first = await inspect(appRoot);
    expect((await inspect(appRoot)).compiledAt).not.toBe(first.compiledAt);
    await expect(stat(resolveInspectCachePath(appRoot))).rejects.toThrow();
  });
});
