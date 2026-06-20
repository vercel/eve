import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEV_RUNTIME_SNAPSHOT_METADATA_FILE_NAME,
  DEV_RUNTIME_SNAPSHOT_METADATA_KIND,
  DEV_RUNTIME_SNAPSHOT_METADATA_VERSION,
} from "#internal/nitro/dev-runtime-snapshot-metadata.js";
import { normalizeDevelopmentSourceMapForDevTools } from "#internal/nitro/host/dev-source-map-normalize-plugin.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("normalizeDevelopmentSourceMapForDevTools", () => {
  it("folds sourceRoot into relative sources before dropping sourceRoot", async () => {
    const appRoot = await createScratchDirectory("eve-dev-sourcemap-source-root-");
    const sourcePath = join(appRoot, "agent", "tools", "source-root-breakpoint.ts");
    const sourceMapPath = join(appRoot, ".eve", "nitro", "server", "index.mjs.map");

    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(sourceMapPath), { recursive: true });
    await writeFile(sourcePath, "export const sourceRootBreakpoint = true;\n");
    await writeFile(
      sourceMapPath,
      `${JSON.stringify({
        mappings: "",
        sourceRoot: appRoot,
        sources: ["agent/tools/source-root-breakpoint.ts", "node:fs"],
        version: 3,
      })}\n`,
    );

    expect(normalizeDevelopmentSourceMapForDevTools(sourceMapPath, { appRoot })).toBe(true);

    const normalized = JSON.parse(await readFile(sourceMapPath, "utf8")) as {
      readonly ignoreList: readonly number[];
      readonly sourceRoot?: unknown;
      readonly sources: readonly string[];
    };
    expect(normalized.sources).toEqual([pathToFileURL(sourcePath).href, "node:fs"]);
    expect(normalized.sourceRoot).toBeUndefined();
    expect(normalized.ignoreList).toEqual([1]);
  });

  it("rewrites file URL dev snapshot sources away from the .eve snapshot tree", async () => {
    const sourceRoot = await createScratchDirectory("eve-dev-sourcemap-normalize-");
    const appRoot = join(sourceRoot, "apps", "agent-tools");
    const snapshotRoot = join(appRoot, ".eve", "dev-runtime", "snapshots", "revision-a");
    const snapshotSourceRoot = join(snapshotRoot, "source");
    const runtimeAppRoot = join(snapshotSourceRoot, "apps", "agent-tools");
    const authoredSnapshotPath = join(runtimeAppRoot, "agent", "tools", "dynamic-echo.ts");
    const runtimeArtifactPath = join(
      runtimeAppRoot,
      ".eve",
      "compile",
      "compiled-agent-manifest.json",
    );
    const sourceMapPath = join(snapshotRoot, "server", "index.mjs.map");

    await mkdir(dirname(authoredSnapshotPath), { recursive: true });
    await mkdir(dirname(runtimeArtifactPath), { recursive: true });
    await mkdir(dirname(sourceMapPath), { recursive: true });
    await writeFile(authoredSnapshotPath, "export const dynamicEcho = true;\n");
    await writeFile(runtimeArtifactPath, "{}\n");
    await writeFile(
      join(snapshotRoot, DEV_RUNTIME_SNAPSHOT_METADATA_FILE_NAME),
      `${JSON.stringify(
        {
          appRoot,
          kind: DEV_RUNTIME_SNAPSHOT_METADATA_KIND,
          runtimeAppRoot,
          snapshotRoot,
          snapshotSourceRoot,
          sourceRoot,
          version: DEV_RUNTIME_SNAPSHOT_METADATA_VERSION,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      sourceMapPath,
      `${JSON.stringify({
        mappings: "",
        sources: [
          pathToFileURL(authoredSnapshotPath).href,
          pathToFileURL(runtimeArtifactPath).href,
          "node:fs",
        ],
        version: 3,
      })}\n`,
    );

    expect(normalizeDevelopmentSourceMapForDevTools(sourceMapPath, { appRoot })).toBe(true);

    const normalized = JSON.parse(await readFile(sourceMapPath, "utf8")) as {
      readonly ignoreList: readonly number[];
      readonly sources: readonly string[];
    };
    expect(normalized.sources).toEqual([
      pathToFileURL(join(appRoot, "agent", "tools", "dynamic-echo.ts")).href,
      "eve://runtime/.eve/compile/compiled-agent-manifest.json",
      "node:fs",
    ]);
    expect(normalized.ignoreList).toEqual([1, 2]);
  });
});
