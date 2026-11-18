import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION } from "#compiler/extension-compatibility.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { inspectApplication } from "#services/inspect-application.js";
import { readCachedCompile, resolveInspectCachePath } from "#services/inspect-cache.js";

const AGENT = [
  'import { defineAgent } from "eve";',
  'export default defineAgent({ model: "openai/gpt-5.5", modelContextWindowTokens: 200000 });',
  "",
].join("\n");

function tool(description: string): string {
  return [
    'import { label } from "../../lib/label.ts";',
    `export default { description: ${description}, execute: () => null };`,
    "",
  ].join("\n");
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
  const previousEnv = process.env.INSPECT_CACHE_TEST_LABEL;

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.INSPECT_CACHE_TEST_LABEL;
    else process.env.INSPECT_CACHE_TEST_LABEL = previousEnv;
  });

  async function createApp(
    prefix: string,
    toolSource: string,
    extraFiles: Readonly<Record<string, string>> = {},
  ) {
    const app = await createAppRoot(prefix, {
      files: {
        ...extraFiles,
        ".eve/cache/model-catalog.json": JSON.stringify({
          fetchedAt: new Date(Date.now() + 3_600_000).toISOString(),
          kind: "eve-model-catalog-cache",
          models: [],
          providerAliases: {},
          version: 2,
        }),
        "agent/agent.ts": AGENT,
        "agent/instructions.md": "Answer briefly.\n",
        "agent/tools/lookup.ts": toolSource,
        "lib/label.ts": 'export const label = "first";\n',
      },
    });
    await backdate(app.appRoot);
    return app;
  }

  async function inspectTwice(appRoot: string) {
    const first = await inspectApplication(appRoot, { cache: "read" });
    const manifestPath = first.compiledState!.paths.compiledManifestPath;
    const compiledAt = (await stat(manifestPath)).mtimeMs;
    const second = await inspectApplication(appRoot, { cache: "read" });
    return { first, second, recompiled: (await stat(manifestPath)).mtimeMs !== compiledAt };
  }

  function toolDescription(inspection: Awaited<ReturnType<typeof inspectApplication>>) {
    return inspection.compiledState!.manifest.tools.find((entry) => entry.name === "lookup")
      ?.description;
  }

  it("reuses the last compile when nothing changed", async () => {
    const app = await createApp("eve-inspect-cache-hit-", tool("label"));

    const { first, second, recompiled } = await inspectTwice(app.appRoot);

    expect(recompiled).toBe(false);
    expect(second.compiledState).toEqual(JSON.parse(JSON.stringify(first.compiledState)));
  });

  it("recompiles when a module outside the agent directory changes", async () => {
    const app = await createApp("eve-inspect-cache-lib-", tool("label"));
    await inspectApplication(app.appRoot, { cache: "read" });

    await writeFile(join(app.appRoot, "lib", "label.ts"), 'export const label = "second";\n');
    await backdate(app.appRoot);
    const inspection = await inspectApplication(app.appRoot, { cache: "read" });

    expect(toolDescription(inspection)).toBe("second");
  });

  it("misses the cache when an environment variable a module reads changes", async () => {
    const app = await createApp(
      "eve-inspect-cache-env-",
      tool('process.env.INSPECT_CACHE_TEST_LABEL ?? "unset"'),
    );
    process.env.INSPECT_CACHE_TEST_LABEL = "first";
    await inspectApplication(app.appRoot, { cache: "read" });

    expect(await readCachedCompile(app.appRoot)).not.toBeNull();
    process.env.INSPECT_CACHE_TEST_LABEL = "second";
    expect(await readCachedCompile(app.appRoot)).toBeNull();
  });

  it.each([
    ["a computed key", 'process.env["INSPECT_" + "CACHE_TEST_LABEL"] ?? label'],
    ["bracket access to env", 'process["env"].INSPECT_CACHE_TEST_LABEL ?? label'],
    ["optional chaining", "process?.env.INSPECT_CACHE_TEST_LABEL ?? label"],
    [
      "destructuring",
      "(({ INSPECT_CACHE_TEST_LABEL }) => INSPECT_CACHE_TEST_LABEL ?? label)(process.env)",
    ],
    [
      "destructuring env from process",
      "(() => { const { env } = process; return env.INSPECT_CACHE_TEST_LABEL ?? label; })()",
    ],
  ])("does not cache a compile whose modules read the environment through %s", async (_, read) => {
    const app = await createApp("eve-inspect-cache-dynamic-env-", tool(read));

    const { recompiled } = await inspectTwice(app.appRoot);

    expect(recompiled).toBe(true);
    await expect(stat(resolveInspectCachePath(app.appRoot))).rejects.toThrow();
  });

  async function expectMissAfter(appRoot: string, change: () => Promise<void>) {
    await inspectApplication(appRoot, { cache: "read" });
    expect(await readCachedCompile(appRoot)).not.toBeNull();
    await change();
    await backdate(appRoot);
    expect(await readCachedCompile(appRoot)).toBeNull();
  }

  it("misses the cache when a module's package manifest changes", async () => {
    const app = await createApp("eve-inspect-cache-package-manifest-", tool("label"), {
      "lib/package.json": JSON.stringify({ name: "shared-lib", type: "module" }),
    });

    await expectMissAfter(app.appRoot, () =>
      writeFile(
        join(app.appRoot, "lib", "package.json"),
        JSON.stringify({ name: "shared-lib", type: "module", exports: "./label.ts" }),
      ),
    );
  });

  it("misses the cache when a path alias config changes", async () => {
    const app = await createApp("eve-inspect-cache-jsconfig-", tool("label"), {
      "jsconfig.json": JSON.stringify({ compilerOptions: { paths: {} } }),
    });

    await expectMissAfter(app.appRoot, () =>
      writeFile(
        join(app.appRoot, "jsconfig.json"),
        JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./lib/*"] } } }),
      ),
    );
  });

  it("misses the cache when the Node.js conditions change", async () => {
    const app = await createApp("eve-inspect-cache-conditions-", tool("label"));
    const previous = process.env.NODE_OPTIONS;
    try {
      await expectMissAfter(app.appRoot, async () => {
        process.env.NODE_OPTIONS = "--conditions=development";
      });
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });

  it("misses the cache when a mounted extension's files change", async () => {
    const app = await createApp("eve-inspect-cache-extension-", tool("label"), {
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
    });
    const first = await inspectApplication(app.appRoot, { cache: "read" });
    expect(first.compiledState!.manifest.extensionMounts).toHaveLength(1);

    await expectMissAfter(app.appRoot, () =>
      writeFile(
        join(app.appRoot, "node_modules", "@acme", "crm", "extension", "skills", "audit.md"),
        "---\nname: audit\ndescription: Audit accounts.\n---\n\nAudit them.\n",
      ),
    );
  });

  it("reuses and invalidates the cache for a large project", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1) {
      files[`agent/tools/tool_${index}.ts`] = tool(`label + " ${index}"`);
      files[`agent/skills/skill-${index}.md`] =
        `---\nname: skill-${index}\ndescription: Skill ${index}.\n---\n\nDo ${index}.\n`;
    }
    for (let index = 0; index < 15; index += 1) {
      files[`agent/subagents/helper-${index}/agent.ts`] = [
        'import { defineAgent } from "eve";',
        `export default defineAgent({ description: "Helper ${index}.", model: "openai/gpt-5.5", modelContextWindowTokens: 200000 });`,
        "",
      ].join("\n");
      files[`agent/subagents/helper-${index}/instructions.md`] = `Help with ${index}.\n`;
      files[`agent/subagents/helper-${index}/tools/lookup.ts`] = [
        'import { label } from "../../../../lib/label.ts";',
        `export default { description: label + " helper ${index}", execute: () => null };`,
        "",
      ].join("\n");
    }
    const app = await createAppRoot("eve-inspect-cache-large-", {
      files: {
        ".eve/cache/model-catalog.json": JSON.stringify({
          fetchedAt: new Date(Date.now() + 3_600_000).toISOString(),
          kind: "eve-model-catalog-cache",
          models: [],
          providerAliases: {},
          version: 2,
        }),
        "agent/agent.ts": AGENT,
        "agent/instructions.md": "Answer briefly.\n",
        "lib/label.ts": 'export const label = "first";\n',
        ...files,
      },
    });
    await backdate(app.appRoot);

    const { first, second, recompiled } = await inspectTwice(app.appRoot);
    expect(recompiled).toBe(false);
    expect(first.compiledState!.manifest.skills).toHaveLength(150);
    expect(first.compiledState!.manifest.subagents).toHaveLength(15);
    expect(second.compiledState).toEqual(JSON.parse(JSON.stringify(first.compiledState)));

    await writeFile(
      join(app.appRoot, "agent", "subagents", "helper-9", "tools", "lookup.ts"),
      'export default { description: "changed", execute: () => null };\n',
    );
    await backdate(app.appRoot);
    expect(await readCachedCompile(app.appRoot)).toBeNull();
    const changed = await inspectApplication(app.appRoot, { cache: "read" });
    const helper = changed.compiledState!.manifest.subagents.find(
      (subagent) => subagent.name === "helper-9",
    );
    expect(helper?.agent.tools.find((entry) => entry.name === "lookup")?.description).toBe(
      "changed",
    );
  }, 120_000);

  it("recompiles on refresh", async () => {
    const app = await createApp("eve-inspect-cache-refresh-", tool("label"));
    const first = await inspectApplication(app.appRoot, { cache: "read" });
    const manifestPath = first.compiledState!.paths.compiledManifestPath;
    const compiledAt = (await stat(manifestPath)).mtimeMs;

    await inspectApplication(app.appRoot, { cache: "refresh" });

    expect((await stat(manifestPath)).mtimeMs).not.toBe(compiledAt);
  });
});
