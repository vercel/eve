import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { serializeHeadlessSetupEvent, type HeadlessSetupEvent } from "./setup-headless.js";

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

const PNPM_INSTALL_FAILURE_REASONS = {
  ERR_PNPM_FETCH_401: "Registry authentication failed",
  ERR_PNPM_FETCH_403: "Registry access was denied",
  ERR_PNPM_FETCH_404: "Package was not found in the registry",
  ERR_PNPM_FETCH_429: "Registry rate limit reached",
  ERR_PNPM_NO_MATCHING_VERSION: "No matching package version was found",
  ERR_PNPM_PEER_DEP_ISSUES: "Peer dependencies are incompatible",
  ERR_PNPM_OUTDATED_LOCKFILE: "The lockfile is out of date",
} as const;

/** shadcn buffers installer output in the thrown error, not in eve's runtime log stream. */
function interactiveInstallFailureMessage(error: unknown): string {
  if (typeof error !== "object" || error === null)
    return "Dependency installation failed; no safe diagnostic was available.";
  const failure = error as {
    exitCode?: unknown;
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  // shadcn's execa failure may include credentials in stderr, command args, or
  // URLs. Only recognized package-manager codes and numeric exit status are safe
  // to surface in the transcript; /loglevel cannot retrieve this buffered output.
  const text = [failure.stderr, failure.message]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const pnpmCode = /\bERR_PNPM_[A-Z0-9_]+\b/u.exec(text)?.[0];
  const reason =
    pnpmCode !== undefined && Object.hasOwn(PNPM_INSTALL_FAILURE_REASONS, pnpmCode)
      ? PNPM_INSTALL_FAILURE_REASONS[pnpmCode as keyof typeof PNPM_INSTALL_FAILURE_REASONS]
      : undefined;
  const exitCode =
    typeof failure.exitCode === "number" && Number.isSafeInteger(failure.exitCode)
      ? failure.exitCode
      : undefined;
  const spawnCode = failure.code === "ENOENT" ? "package manager not found" : undefined;
  const detail = [
    spawnCode,
    reason === undefined ? undefined : `${reason} (${pnpmCode})`,
    exitCode === undefined ? undefined : `exit code ${exitCode}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return detail === ""
    ? "Dependency installation failed; no safe diagnostic was available."
    : `Dependency installation failed (${detail}).`;
}

export async function installRegistryItemTransaction(input: {
  readonly appRoot: string;
  readonly item: string;
  readonly registryItem: unknown;
  readonly nonInteractive: boolean | undefined;
  readonly logger: { log(message: string): void };
  /** TUI diagnostic sink; absent for CLI and headless installs. */
  readonly onInstallFailureOutput?: (stderr: string) => void;
  readonly install: () => Promise<void>;
}): Promise<void> {
  const snapshot = await snapshotRegistryInstall(input.appRoot, input.registryItem);
  try {
    await input.install();
  } catch (error) {
    const rollback = await rollbackRegistryInstall(input.appRoot, snapshot);
    const failureCode = registryInstallFailureCode(error);
    const message = registryInstallFailureMessage(failureCode);
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? (error as { stderr?: unknown }).stderr
        : undefined;
    const hasFailureOutput =
      !input.nonInteractive &&
      input.onInstallFailureOutput !== undefined &&
      typeof stderr === "string" &&
      stderr.trim().length > 0;
    if (hasFailureOutput) input.onInstallFailureOutput?.(stderr);
    if (input.nonInteractive) {
      const failureEvent: Extract<HeadlessSetupEvent, { type: "failed" }> = {
        version: 1,
        type: "failed",
        item: input.item,
        completedItems: [],
        message,
        failureCode,
        rolledBack: rollback.restored,
      };
      if (rollback.changed.length > 0) failureEvent.changed = rollback.changed;
      input.logger.log(serializeHeadlessSetupEvent(failureEvent));
    }
    throw new Error(
      failureCode === "pnpm_build_policy"
        ? message
        : input.nonInteractive
          ? message
          : `${interactiveInstallFailureMessage(error)}${hasFailureOutput ? " Run `/loglevel all` to see the installer error." : ""}`,
      { cause: error },
    );
  }
}
