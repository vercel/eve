import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "./path-exists.js";

export type PackageManagerKind = "bun" | "npm" | "pnpm" | "yarn";

/** How a project's package manager was identified, most authoritative first. */
export type PackageManagerSource = "package-manager-field" | "lockfile" | "default";

export interface DetectedPackageManager {
  kind: PackageManagerKind;
  source: PackageManagerSource;
}

/** Lockfiles in detection precedence order. */
const LOCKFILE_MANAGERS: ReadonlyArray<readonly [string, PackageManagerKind]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

function isPackageManagerKind(value: string): value is PackageManagerKind {
  return value === "bun" || value === "npm" || value === "pnpm" || value === "yarn";
}

/**
 * Resolves a project's package manager from gathered facts: an explicit
 * `packageManager` field wins, then the first known lockfile, then pnpm.
 */
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

/**
 * Identifies the package manager that launched the current process from an
 * npm user-agent string. Every manager advertises itself there when running
 * a binary (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`, run-scripts), e.g.
 * `"pnpm/10.4.0 npm/? node/v24.0.0 darwin arm64"` → pnpm. A binary executed
 * directly carries no user agent and yields undefined.
 */
export function packageManagerFromUserAgent(
  userAgent: string | undefined,
): PackageManagerKind | undefined {
  const kind = userAgent?.split("/", 1)[0];
  return kind !== undefined && isPackageManagerKind(kind) ? kind : undefined;
}

/** Reads {@link packageManagerFromUserAgent} from the process environment. */
export function detectInvokingPackageManager(): PackageManagerKind | undefined {
  return packageManagerFromUserAgent(process.env.npm_config_user_agent);
}

/** Reads the detection facts for {@link resolvePackageManager} from `projectRoot`. */
export async function detectPackageManager(projectRoot: string): Promise<DetectedPackageManager> {
  let packageManagerField: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "packageManager" in parsed &&
      typeof parsed.packageManager === "string"
    ) {
      packageManagerField = parsed.packageManager;
    }
  } catch {
    // Missing or unparsable package.json: the lockfiles decide.
  }

  const lockfiles: string[] = [];
  for (const [lockfile] of LOCKFILE_MANAGERS) {
    if (await pathExists(join(projectRoot, lockfile))) {
      lockfiles.push(lockfile);
    }
  }

  return resolvePackageManager({ packageManagerField, lockfiles });
}
