import { readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH } from "#internal/authored-module-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const tool = (marker: string) =>
  `export default { description: "Return ${marker}.", inputSchema: { type: "object" }, execute: () => "${marker}" };\n`;

describe("authored-module cache", () => {
  const createAppRoot = useTemporaryAppRoots();

  it("prunes bundles that an edit superseded once they go stale", async () => {
    const app = await createAppRoot("eve-authored-module-cache-", {
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/tools/edited.ts": tool("first"),
        "agent/tools/unchanged.ts": tool("unchanged"),
      },
    });
    const cacheDirectory = join(await realpath(app.appRoot), AUTHORED_MODULE_BUNDLE_DIRECTORY_PATH);
    const compile = async () =>
      await compileAgentManifest(
        (await discoverAgent({ agentRoot: app.agentRoot, appRoot: app.appRoot })).manifest,
      );
    const listCache = async () => new Set(await readdir(cacheDirectory));

    await compile();
    const firstFiles = await listCache();
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const fileName of firstFiles)
      await utimes(join(cacheDirectory, fileName), longAgo, longAgo);
    // A bundle another process wrote recently is still in use.
    await writeFile(join(cacheDirectory, "other-process.mjs"), "export {};\n");

    await writeFile(join(app.agentRoot, "tools", "edited.ts"), tool("second"));
    await compile();
    const secondFiles = await listCache();

    const superseded = [...firstFiles].filter((fileName) => !secondFiles.has(fileName));
    const reused = [...firstFiles].filter((fileName) => secondFiles.has(fileName));
    expect(superseded.length).toBeGreaterThan(0);
    expect(reused.length).toBeGreaterThan(0);
    expect(secondFiles.has("other-process.mjs")).toBe(true);
    for (const fileName of reused) {
      expect((await stat(join(cacheDirectory, fileName))).mtimeMs).toBeGreaterThan(
        longAgo.getTime(),
      );
    }
  });
});
