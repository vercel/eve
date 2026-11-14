import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { resolveInstalledPackageInfo, resolvePackageRoot } from "#internal/application/package.js";
import type { DevelopmentHostBuild } from "#internal/nitro/host/dev-build-host.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import { resolveTsConfigDependencyPaths } from "#internal/application/tsconfig-dependencies.js";
import { findAuthoredPackageRoot } from "#internal/authored-package-boundary.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { mapConcurrent } from "#shared/map-concurrent.js";

const RECORD_FILE = "reusable-host.json";
/** Set to `0` to rebuild the development host on every start. */
export const DEVELOPMENT_HOST_REUSE_ENV = "EVE_DEV_HOST_REUSE";
// eve's code that generates a host is not in the host's module graph.
const HOST_BUILDER_DIRECTORIES = [
  "internal/nitro/host",
  "internal/workflow-bundle",
  "internal/bundler",
];
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];

/** A built development host kept after `eve dev` exits, for the next start to reuse. */
export interface ReusableDevelopmentHost {
  readonly key: string;
  readonly payload: DevelopmentHostBuild;
  readonly compiledArtifacts: PreparedDevelopmentApplicationHost["compiledArtifacts"];
  readonly workflowBuildDir: string;
  readonly workspace: PreparedDevelopmentApplicationHost["workspace"];
}

function hostsDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "dev-hosts");
}

function recordPath(appRoot: string): string {
  return join(hostsDirectory(appRoot), RECORD_FILE);
}

/** Whether the record's workspace and entry live in this app's own hosts directory. */
function ownsWorkspace(appRoot: string, record: Partial<ReusableDevelopmentHost>): boolean {
  const rootDir = record.workspace?.rootDir;
  const entry = record.payload?.entry;
  if (rootDir === undefined || entry === undefined) return false;
  // The entry is recorded beside its workspace, so it may be gone but never elsewhere.
  if (!entry.startsWith(`${rootDir}${sep}`)) return false;
  try {
    return realpathSync.native(dirname(rootDir)) === realpathSync.native(hostsDirectory(appRoot));
  } catch {
    return false;
  }
}

/**
 * The host fingerprint covers what eve's host build reads from the app. A host
 * also bundles eve's runtime and the app's installed packages with the app's
 * tsconfig transform options, so the key adds eve's identity and the code that
 * builds hosts, the Node runtime, the nearest lockfiles, and the tsconfig
 * chain's contents. Returns undefined when hosts must not be reused.
 */
export async function computeDevelopmentHostReuseKey(
  host: PreparedDevelopmentApplicationHost,
): Promise<string | undefined> {
  if (process.env[DEVELOPMENT_HOST_REUSE_ENV] === "0") return undefined;
  const evePackageRoot = realpathSync.native(resolvePackageRoot());
  // A linked or source checkout changes without a version bump.
  if (!evePackageRoot.split(/[\\/]/u).includes("node_modules")) return undefined;
  const lockfiles: string[] = [];
  for (let directory = host.appRoot; ; directory = dirname(directory)) {
    for (const name of LOCKFILES) {
      const contents = await readFile(join(directory, name)).catch(() => undefined);
      if (contents !== undefined) {
        lockfiles.push(name, createHash("sha256").update(contents).digest("hex"));
      }
    }
    if (dirname(directory) === directory || lockfiles.length > 0) break;
  }
  const packageRoot = findAuthoredPackageRoot(host.appRoot) ?? host.appRoot;
  const tsconfigs = await Promise.all(
    [...new Set([host.appRoot, packageRoot])].map(async (root) =>
      Promise.all(
        (await resolveTsConfigDependencyPaths(root)).map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(path).catch(() => ""))
            .digest("hex"),
        ]),
      ),
    ),
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        await computeDevelopmentHostFingerprint(host),
        tsconfigs,
        await statHostBuilderCode(evePackageRoot),
        resolveInstalledPackageInfo().version,
        evePackageRoot,
        process.version,
        process.arch,
        lockfiles,
      ]),
    )
    .digest("hex");
}

export type DevelopmentHostClaim =
  | { readonly kind: "reused"; readonly host: ReusableDevelopmentHost }
  /** A kept host was found and removed, for `reason`. */
  | { readonly kind: "rebuilt"; readonly reason: string }
  | { readonly kind: "none" };

/**
 * Takes the kept host if it matches `key`, which is awaited only when a kept
 * host exists. Taking renames the record first, so concurrent servers never
 * share a workspace, and a kept host that does not match is removed. Never
 * throws.
 */
export async function claimReusableDevelopmentHost(
  appRoot: string,
  key: Promise<string | undefined>,
): Promise<DevelopmentHostClaim> {
  const claimPath = `${recordPath(appRoot)}.${String(process.pid)}.claim`;
  try {
    await rename(recordPath(appRoot), claimPath);
  } catch {
    return { kind: "none" };
  }
  try {
    const record = JSON.parse(
      await readFile(claimPath, "utf8"),
    ) as Partial<ReusableDevelopmentHost>;
    // A record copied along with the app names another app's workspace; only
    // this app's copy of that directory is ours to remove.
    if (!ownsWorkspace(appRoot, record)) {
      if (record.workspace?.rootDir !== undefined) {
        await removeHostDirectory(appRoot, basename(record.workspace.rootDir));
      }
      return { kind: "rebuilt", reason: "it was copied from another app" };
    }
    const reason = await staleReason(record, await key);
    if (reason === undefined) return { kind: "reused", host: record as ReusableDevelopmentHost };
    await rm(record.workspace!.rootDir, { force: true, recursive: true });
    return { kind: "rebuilt", reason };
  } catch {
    return { kind: "none" };
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

async function staleReason(
  record: Partial<ReusableDevelopmentHost>,
  key: string | undefined,
): Promise<string | undefined> {
  if (key === undefined) {
    return process.env[DEVELOPMENT_HOST_REUSE_ENV] === "0"
      ? `${DEVELOPMENT_HOST_REUSE_ENV}=0`
      : "this eve install is linked or from source";
  }
  if (record.key !== key)
    return "the agent, its env files, eve, Node, a lockfile, or tsconfig changed";
  if (record.payload === undefined || !existsSync(record.payload.entry)) {
    return "its build output is missing";
  }
  if (!(await inputsUnchanged(record.payload.inputs))) return "a file it was built from changed";
  return undefined;
}

async function removeHostDirectory(appRoot: string, name: string): Promise<void> {
  if (name === RECORD_FILE || name.length === 0) return;
  await rm(join(hostsDirectory(appRoot), name), { force: true, recursive: true });
}

/** Modification time and size of eve's host-builder code, which a patched install changes. */
async function statHostBuilderCode(evePackageRoot: string): Promise<string[]> {
  const files = (
    await Promise.all(
      HOST_BUILDER_DIRECTORIES.map(async (directory) => {
        const root = join(evePackageRoot, "dist", "src", directory);
        const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
          () => [],
        );
        return entries.flatMap((entry) =>
          entry.isFile() ? [join(entry.parentPath, entry.name)] : [],
        );
      }),
    )
  )
    .flat()
    .sort();
  const stats = await mapConcurrent(files, async (file) => await stat(file).catch(() => undefined));
  return files.map((file, index) => `${file}:${stats[index]?.mtimeMs}:${stats[index]?.size}`);
}

/** A host without recorded inputs is never reused. */
async function inputsUnchanged(
  inputs: Readonly<Record<string, readonly [number, number]>> | undefined,
): Promise<boolean> {
  if (inputs === undefined) return false;
  const entries = Object.entries(inputs);
  if (entries.length === 0) return false;
  const current = await mapConcurrent(
    entries,
    async ([file]) => await stat(file).catch(() => undefined),
  );
  return entries.every(([, [mtimeMs, size]], index) => {
    const fileStat = current[index];
    return fileStat !== undefined && fileStat.mtimeMs === mtimeMs && fileStat.size === size;
  });
}

/** Keeps `record` for the next start, replacing and removing any host kept before it. */
export async function writeReusableDevelopmentHost(
  record: ReusableDevelopmentHost,
  appRoot: string,
): Promise<void> {
  // Taken like a claim, so a server starting now never loses a host it just took.
  const takenPath = `${recordPath(appRoot)}.${String(process.pid)}.replaced`;
  const previous = await rename(recordPath(appRoot), takenPath)
    .then(
      async () => JSON.parse(await readFile(takenPath, "utf8")) as Partial<ReusableDevelopmentHost>,
    )
    .catch(() => undefined)
    .finally(async () => await rm(takenPath, { force: true }).catch(() => undefined));
  const previousRoot = previous?.workspace?.rootDir;
  if (previousRoot !== undefined && previousRoot !== record.workspace.rootDir) {
    await removeHostDirectory(appRoot, basename(previousRoot)).catch(() => undefined);
  }
  await atomicWriteFile(recordPath(appRoot), JSON.stringify(record)).catch(() => undefined);
}
