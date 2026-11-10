import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import type { Plugin } from "rolldown";

import { resolvePackageRoot } from "#internal/application/package.js";
import { resolveRolldownPackageDir } from "#internal/bundler/rolldown.js";
import type { WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { mapConcurrent } from "#shared/map-concurrent.js";

const CACHE_DIRECTORY_PATH = join("node_modules", ".cache", "eve", "workflow-driver");

export interface DriverChunk {
  readonly code: string;
  readonly manifest: WorkflowManifest;
}

interface CacheEntry extends DriverChunk {
  readonly key: string;
  /** Content hash of each module in the chunk's build graph, by absolute path. */
  readonly modules: Readonly<Record<string, string>>;
}

/**
 * eve's real package root when it is installed under `node_modules`, where its
 * version pins all of eve's code, including the workflow transform. `undefined`
 * for a linked or source checkout, whose code changes without a version bump.
 */
export function resolveInstalledEveRoot(): string | undefined {
  const root = realpathSync.native(resolvePackageRoot());
  return root.split(sep).includes("node_modules") ? root : undefined;
}

/**
 * Returns the framework driver chunk an earlier build of the same installed eve
 * stored under `packageRoot`, or builds and stores it. Each entry records the
 * modules of its build graph with a content hash, so a package edited in place,
 * for example by `patch-package`, rebuilds. Cache failures never fail the build.
 */
export async function reuseFrameworkDriverChunk(
  input: {
    readonly eveRoot: string;
    readonly inlineSourcemap: boolean;
    readonly inputFiles: readonly string[];
    readonly packageRoot: string;
    readonly projectRoot: string;
    readonly workingDir: string;
  },
  build: (graphPlugin: Plugin) => Promise<DriverChunk>,
): Promise<DriverChunk> {
  // One entry per option set, replaced when stale, so the directory cannot grow.
  const path = join(
    input.packageRoot,
    CACHE_DIRECTORY_PATH,
    input.inlineSourcemap ? "framework-mapped.json" : "framework.json",
  );
  const key = await createKey(input).catch(() => undefined);
  const cached = key === undefined ? undefined : await readEntry(path, key).catch(() => undefined);
  if (cached !== undefined) return cached;

  let modules: Record<string, string> | undefined;
  const chunk = await build({
    name: "eve-framework-driver-graph",
    async buildEnd() {
      modules = await hashModules([...this.getModuleIds()]).catch(() => undefined);
    },
  });
  if (key !== undefined && modules !== undefined) {
    const entry: CacheEntry = { code: chunk.code, key, manifest: chunk.manifest, modules };
    await mkdir(dirname(path), { recursive: true })
      .then(() => atomicWriteFile(path, JSON.stringify(entry)))
      .catch(() => undefined);
  }
  return chunk;
}

async function createKey(input: {
  readonly eveRoot: string;
  readonly inlineSourcemap: boolean;
  readonly inputFiles: readonly string[];
  readonly projectRoot: string;
  readonly workingDir: string;
}): Promise<string> {
  const [evePackageJson, rolldownPackageJson] = await Promise.all([
    readFile(join(input.eveRoot, "package.json"), "utf8"),
    readFile(join(resolveRolldownPackageDir(), "package.json"), "utf8"),
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        evePackageJson,
        rolldownPackageJson,
        input.eveRoot,
        input.inlineSourcemap,
        [...input.inputFiles].sort(),
        input.projectRoot,
        input.workingDir,
      ]),
    )
    .digest("hex");
}

async function readEntry(path: string, key: string): Promise<DriverChunk | undefined> {
  const entry = JSON.parse(await readFile(path, "utf8")) as Partial<CacheEntry>;
  if (
    entry.key !== key ||
    typeof entry.code !== "string" ||
    typeof entry.manifest !== "object" ||
    entry.manifest === null
  ) {
    return undefined;
  }
  const recorded = Object.entries(entry.modules ?? {});
  const current = await hashModules(recorded.map(([id]) => id));
  if (recorded.length === 0 || recorded.some(([id, hash]) => current[id] !== hash)) {
    return undefined;
  }
  return { code: entry.code, manifest: entry.manifest };
}

/** Virtual modules have no file; the cache key covers what produces them. */
async function hashModules(ids: readonly string[]): Promise<Record<string, string>> {
  const files = ids.filter((id) => isAbsolute(id));
  const hashes = await mapConcurrent(files, async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  );
  return Object.fromEntries(files.map((file, index) => [file, hashes[index]!]));
}
