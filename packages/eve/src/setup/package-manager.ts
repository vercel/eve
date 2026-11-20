import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { pathExists } from "./path-exists.js";

export type PackageManagerKind = "bun" | "npm" | "pnpm" | "yarn";

export type PackageManagerSource = "package-manager-field" | "lockfile" | "default";

export interface DetectedPackageManager {
  kind: PackageManagerKind;
  source: PackageManagerSource;
}

const LOCKFILE_MANAGERS: ReadonlyArray<readonly [string, PackageManagerKind]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

function isPackageManagerKind(value: string): value is PackageManagerKind {
  return value === "bun" || value === "npm" || value === "pnpm" || value === "yarn";
}

export function resolvePackageManager(input: {
  packageManagerField?: string;
  lockfiles: readonly string[];
}): DetectedPackageManager {
  const fieldKind = input.packageManagerField?.split("@", 1)[0]?.trim();
  if (fieldKind !== undefined && isPackageManagerKind(fieldKind)) {
    return { kind: fieldKind, source: "package-manager-field" };
  }

  for (const [lockfile, kind] of LOCKFILE_MANAGERS) {
    if (input.lockfiles.includes(lockfile)) {
      return { kind, source: "lockfile" };
    }
  }

  return { kind: "pnpm", source: "default" };
}

export function packageManagerFromUserAgent(
  userAgent: string | undefined,
): PackageManagerKind | undefined {
  const kind = userAgent?.split("/", 1)[0];
  return kind !== undefined && isPackageManagerKind(kind) ? kind : undefined;
}

export function detectInvokingPackageManager(): PackageManagerKind | undefined {
  return packageManagerFromUserAgent(process.env.npm_config_user_agent);
}

async function detectPackageManagerInDirectory(
  directory: string,
): Promise<DetectedPackageManager | undefined> {
  let packageManagerField: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "packageManager" in parsed &&
      typeof parsed.packageManager === "string"
    ) {
      packageManagerField = parsed.packageManager;
    }
  } catch {}

  const lockfiles: string[] = [];
  for (const [lockfile] of LOCKFILE_MANAGERS) {
    if (await pathExists(join(directory, lockfile))) {
      lockfiles.push(lockfile);
    }
  }

  const resolved = resolvePackageManager({ packageManagerField, lockfiles });
  return resolved.source === "default" ? undefined : resolved;
}

async function detectAncestorPackageManager(
  projectRoot: string,
): Promise<DetectedPackageManager | undefined> {
  let directory = dirname(resolve(projectRoot));
  while (true) {
    const detected = await detectPackageManagerInDirectory(directory);
    if (detected !== undefined) return detected;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function detectPackageManager(projectRoot: string): Promise<DetectedPackageManager> {
  return (
    (await detectPackageManagerInDirectory(resolve(projectRoot))) ??
    (await detectAncestorPackageManager(projectRoot)) ?? { kind: "pnpm", source: "default" }
  );
}
