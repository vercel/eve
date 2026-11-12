import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

import type { Plugin } from "rolldown";

import { resolvePackageRoot } from "#internal/application/package.js";
import { resolveRolldownPackageDir } from "#internal/bundler/rolldown.js";
import type { WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { mapConcurrent } from "#shared/map-concurrent.js";

const CACHE_DIRECTORY_PATH = join("node_modules", ".cache", "eve", "workflow-driver");

// eve's code that builds the layer is not in the layer's graph: the workflow transform and bundler
// setup, and the modules outside them that the transform imports to emit code and ids.
const BUILD_CODE_DIRECTORIES = ["internal/workflow-bundle", "internal/bundler"];
const BUILD_CODE_FILES = [
  "execution/stable-workflow-names.js",
  "execution/workflow-registry.js",
  "internal/application/import-specifier.js",
  "internal/application/package.js",
  "internal/package-name.js",
  "runtime/subagents/workflow-reference.js",
  "tools/workflow-entry-point.js",
];

const buildCodeHashes = new Map<string, Promise<Record<string, string>>>();

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
 * stored under `packageRoot` for this app, or builds and stores it. The key
 * covers eve's package.json and root, Rolldown's version, the build options, and
 * a content hash of eve's workflow-bundle and bundler code plus the modules the
 * transform imports. Each entry also records a content hash of every module in
 * its build graph. So eve edited in place, for example by `patch-package`,
 * rebuilds, unless the edit only touches another module those import, such as a
 * resolution helper of the authored plugins. Cache failures never fail the build.
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
  // One entry per app and sourcemap setting, replaced when stale, so agents sharing a package do
  // not evict each other and the directory grows only with the package's apps.
  const app = createHash("sha256")
    .update(JSON.stringify([input.projectRoot, input.workingDir]))
    .digest("hex")
    .slice(0, 16);
  const path = join(
    input.packageRoot,
    CACHE_DIRECTORY_PATH,
    `framework-${app}${input.inlineSourcemap ? "-mapped" : ""}.json`,
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
  const [evePackageJson, rolldownPackageJson, buildCode] = await Promise.all([
    readFile(join(input.eveRoot, "package.json"), "utf8"),
    readFile(join(resolveRolldownPackageDir(), "package.json"), "utf8"),
    hashBuildCode(input.eveRoot),
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        evePackageJson,
        rolldownPackageJson,
        buildCode,
        input.eveRoot,
        input.inlineSourcemap,
        [...input.inputFiles].sort(),
        input.projectRoot,
        input.workingDir,
      ]),
    )
    .digest("hex");
}

/** Once per process: an installed eve's code does not change under a running build. */
function hashBuildCode(eveRoot: string): Promise<Record<string, string>> {
  let hashes = buildCodeHashes.get(eveRoot);
  if (hashes === undefined) {
    hashes = listBuildCode(join(eveRoot, "dist", "src")).then(hashModules);
    buildCodeHashes.set(eveRoot, hashes);
  }
  return hashes;
}

async function listBuildCode(distRoot: string): Promise<string[]> {
  const entries = await Promise.all(
    BUILD_CODE_DIRECTORIES.map((directory) =>
      readdir(join(distRoot, directory), { recursive: true, withFileTypes: true }),
    ),
  );
  return [
    ...entries
      .flat()
      .flatMap((entry) => (entry.isFile() ? [join(entry.parentPath, entry.name)] : [])),
    ...BUILD_CODE_FILES.map((file) => join(distRoot, file)),
  ].sort();
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
