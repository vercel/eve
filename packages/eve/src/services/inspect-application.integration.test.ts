import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    if (entry.name === "node_modules" || entry.name === ".eve") continue;
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

  async function createApp(prefix: string, toolSource: string) {
    const app = await createAppRoot(prefix, {
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

  it("does not cache a compile whose modules read the environment dynamically", async () => {
    const app = await createApp(
      "eve-inspect-cache-dynamic-env-",
      tool('process.env["INSPECT_" + "CACHE_TEST_LABEL"] ?? label'),
    );

    const { recompiled } = await inspectTwice(app.appRoot);

    expect(recompiled).toBe(true);
    await expect(stat(resolveInspectCachePath(app.appRoot))).rejects.toThrow();
  });

  it("recompiles on refresh", async () => {
    const app = await createApp("eve-inspect-cache-refresh-", tool("label"));
    const first = await inspectApplication(app.appRoot, { cache: "read" });
    const manifestPath = first.compiledState!.paths.compiledManifestPath;
    const compiledAt = (await stat(manifestPath)).mtimeMs;

    await inspectApplication(app.appRoot, { cache: "refresh" });

    expect((await stat(manifestPath)).mtimeMs).not.toBe(compiledAt);
  });
});
