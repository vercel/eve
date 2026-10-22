import { readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { pruneAuthoredModuleCache } from "#internal/authored-module-cache.js";
import { AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH } from "#internal/authored-module-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const tool = (marker: string) =>
  `export default { description: "Return ${marker}.", inputSchema: { type: "object" }, execute: () => "${marker}" };\n`;

const HOUR_MS = 60 * 60 * 1000;

describe("authored-module cache", () => {
  const createAppRoot = useTemporaryAppRoots();

  async function createCachedApp() {
    const app = await createAppRoot("eve-authored-module-cache-", {
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/tools/edited.ts": tool("first"),
        "agent/tools/unchanged.ts": tool("unchanged"),
      },
    });
    const cacheDirectory = join(await realpath(app.appRoot), AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH);
    const listBundles = async () =>
      new Set((await readdir(cacheDirectory)).filter((name) => name.endsWith(".mjs")));
    const compile = async () => {
      await compileAgentManifest(
        (await discoverAgent({ agentRoot: app.agentRoot, appRoot: app.appRoot })).manifest,
      );
      // Compiles start pruning without waiting for it.
      await pruneAuthoredModuleCache();
    };

    await compile();
    const firstBundles = await listBundles();
    // Last used an hour ago: by a process that has since finished, unless a lease says otherwise.
    const hourAgo = new Date(Date.now() - HOUR_MS);
    for (const name of firstBundles) await utimes(join(cacheDirectory, name), hourAgo, hourAgo);
    await writeFile(join(app.agentRoot, "tools", "edited.ts"), tool("second"));
    return { cacheDirectory, compile, firstBundles, listBundles };
  }

  it("removes bundles no running process can import and keeps the ones a compile reused", async () => {
    const { compile, firstBundles, listBundles } = await createCachedApp();

    await compile();

    const secondBundles = await listBundles();
    const reused = [...firstBundles].filter((name) => secondBundles.has(name));
    expect(reused.length).toBeGreaterThan(0);
    expect(reused.length).toBeLessThan(firstBundles.size);
    expect(secondBundles.size).toBeGreaterThan(reused.length);
  });

  it("keeps bundles while an earlier process that may import them is still running", async () => {
    const { cacheDirectory, compile, firstBundles, listBundles } = await createCachedApp();
    const leasePath = join(cacheDirectory, ".leases", "earlier-process.json");
    const lease = { host: hostname(), pid: process.pid, since: Date.now() - 2 * HOUR_MS };
    await writeFile(leasePath, JSON.stringify(lease));

    await compile();
    const whileRunning = await listBundles();
    expect([...firstBundles].every((name) => whileRunning.has(name))).toBe(true);

    // A lease nobody refreshed for longer than the heartbeat expiry belongs to a process that
    // is gone, even though this pid and host still look alive.
    const staleRefresh = new Date(Date.now() - HOUR_MS);
    await utimes(leasePath, staleRefresh, staleRefresh);
    await pruneAuthoredModuleCache();
    const afterwards = await listBundles();
    expect([...firstBundles].some((name) => !afterwards.has(name))).toBe(true);
  });
});
