import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { resolveInstalledPackageInfo, resolvePackageRoot } from "#internal/application/package.js";
import type { DevelopmentHostBuild } from "#internal/nitro/host/dev-build-host.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import { resolveTsConfigDependencyPaths } from "#internal/application/tsconfig-dependencies.js";
import { findAuthoredPackageRoot } from "#internal/authored-package-boundary.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { mapConcurrent } from "#shared/map-concurrent.js";

const RECORD_FILE = "reusable-host.json";
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];

/** A built development host kept after `eve dev` exits, for the next start to reuse. */
interface ReusableDevelopmentHost {
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
 * tsconfig transform options, so the key adds eve's identity, the Node
 * runtime, the nearest lockfiles, and the tsconfig chain's contents.
 */
export async function computeDevelopmentHostReuseKey(
  host: PreparedDevelopmentApplicationHost,
): Promise<string | undefined> {
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
        resolveInstalledPackageInfo().version,
        evePackageRoot,
        process.version,
        process.arch,
        lockfiles,
      ]),
    )
    .digest("hex");
}

/**
 * Takes the kept host for `key`, or returns undefined. Taking renames the
 * record first, so concurrent servers never share a workspace, and a kept host
 * that does not match is removed. Never throws.
 */
export async function claimReusableDevelopmentHost(
  appRoot: string,
  key: string | undefined,
): Promise<ReusableDevelopmentHost | undefined> {
  const claimPath = `${recordPath(appRoot)}.${String(process.pid)}.claim`;
  try {
    await rename(recordPath(appRoot), claimPath);
  } catch {
    return undefined;
  }
  try {
    const record = JSON.parse(
      await readFile(claimPath, "utf8"),
    ) as Partial<ReusableDevelopmentHost>;
    // A record copied along with the app names another app's workspace.
    if (!ownsWorkspace(appRoot, record)) return undefined;
    if (
      key !== undefined &&
      record.key === key &&
      record.payload !== undefined &&
      record.workspace !== undefined &&
      existsSync(record.payload.entry) &&
      (await inputsUnchanged(record.payload.inputs))
    ) {
      return record as ReusableDevelopmentHost;
    }
    if (record.workspace?.rootDir !== undefined) {
      await rm(record.workspace.rootDir, { force: true, recursive: true });
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined);
  }
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

export async function writeReusableDevelopmentHost(
  record: ReusableDevelopmentHost,
  appRoot: string,
): Promise<void> {
  await atomicWriteFile(recordPath(appRoot), JSON.stringify(record)).catch(() => undefined);
}
