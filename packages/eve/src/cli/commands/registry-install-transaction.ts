import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

interface Snapshot {
  readonly path: string;
  readonly contents?: Buffer;
}

// Package-manager state under node_modules is disposable and deliberately not
// restored; manifests and lock/policy files remain the source of truth on retry.
const PROJECT_INSTALL_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".env.example",
  ".env.local",
] as const;

function registryTargets(appRoot: string, item: unknown): string[] {
  if (typeof item !== "object" || item === null || !("files" in item)) return [];
  const files = (item as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    if (typeof file !== "object" || file === null || !("target" in file)) return [];
    const target = (file as { target?: unknown }).target;
    if (typeof target !== "string" || target.length === 0) return [];
    const absolute = resolve(appRoot, target);
    const projectRelative = relative(appRoot, absolute);
    if (isAbsolute(projectRelative) || projectRelative.startsWith("..")) return [];
    return [projectRelative];
  });
}

async function snapshotFile(path: string): Promise<Snapshot> {
  try {
    return { path, contents: await readFile(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
    throw error;
  }
}

export async function snapshotRegistryInstall(
  appRoot: string,
  item: unknown,
): Promise<readonly Snapshot[]> {
  const paths = [...new Set([...PROJECT_INSTALL_FILES, ...registryTargets(appRoot, item)])];
  return await Promise.all(paths.map((path) => snapshotFile(resolve(appRoot, path))));
}

export async function rollbackRegistryInstall(
  appRoot: string,
  snapshots: readonly Snapshot[],
): Promise<{ readonly restored: boolean; readonly changed: readonly string[] }> {
  const changed: string[] = [];
  for (const snapshot of snapshots) {
    try {
      if (snapshot.contents === undefined)
        await unlink(snapshot.path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      else await writeFile(snapshot.path, snapshot.contents);
    } catch {
      changed.push(relative(appRoot, snapshot.path));
    }
  }
  return { restored: changed.length === 0, changed };
}

export type RegistryInstallFailureCode = "pnpm_build_policy" | "dependency_install";

export function registryInstallFailureCode(error: unknown): RegistryInstallFailureCode {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_PNPM_IGNORED_BUILDS") || message.includes("Ignored build scripts")
    ? "pnpm_build_policy"
    : "dependency_install";
}

export function registryInstallFailureMessage(code: RegistryInstallFailureCode): string {
  return code === "pnpm_build_policy"
    ? "Dependency installation stopped because pnpm requires build-script decisions. Run `pnpm approve-builds`, then retry the eve add command."
    : "Dependency installation failed. Retry the eve add command in a terminal for details.";
}
