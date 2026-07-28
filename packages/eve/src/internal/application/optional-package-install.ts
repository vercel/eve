import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { EVE_DEV_ENV_FLAG, isEveDevEnvironment } from "#internal/application/dev-environment.js";

export { EVE_DEV_ENV_FLAG, isEveDevEnvironment };

export type ProjectPackageManager = "bun" | "npm" | "pnpm" | "yarn";

/**
 * Detects the project's package manager from its lockfile, walking up
 * from `appRoot` so workspace members resolve their monorepo root's
 * manager. Defaults to npm when no lockfile is found.
 */
export function detectProjectPackageManager(appRoot: string): ProjectPackageManager {
  let current = appRoot;
  for (;;) {
    if (
      existsSync(join(current, "pnpm-lock.yaml")) ||
      existsSync(join(current, "pnpm-workspace.yaml"))
    ) {
      return "pnpm";
    }
    if (existsSync(join(current, "yarn.lock"))) {
      return "yarn";
    }
    if (existsSync(join(current, "bun.lock")) || existsSync(join(current, "bun.lockb"))) {
      return "bun";
    }
    if (existsSync(join(current, "package-lock.json"))) {
      return "npm";
    }

    const parent = dirname(current);
    if (parent === current) {
      return "npm";
    }
    current = parent;
  }
}

const INSTALL_ARGUMENTS: Record<ProjectPackageManager, readonly string[]> = {
  bun: ["add", "--dev"],
  npm: ["install", "--save-dev"],
  pnpm: ["add", "-D"],
  yarn: ["add", "-D"],
};
const OPTIONAL_PACKAGE_LOCK_POLL_MS = 250;
const OPTIONAL_PACKAGE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const OPTIONAL_PACKAGE_STALE_LOCK_MS = 30 * 60 * 1000;

const pendingOptionalPackageInstalls = new Map<string, Promise<void>>();

/**
 * Installs one package into the application as a devDependency using
 * the project's own package manager, so the install is visible in
 * `package.json` and the lockfile. Throws with the captured output when
 * the install fails.
 */
export async function installPackageIntoProject(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): Promise<void> {
  const packageManager = detectProjectPackageManager(input.appRoot);
  const args = [...INSTALL_ARGUMENTS[packageManager], input.packageName];

  console.info(
    `[eve:dev] installing optional dependency "${input.packageName}" via \`${packageManager} ${args.join(" ")}\`...`,
  );

  const child = spawn(packageManager, args, {
    cwd: input.appRoot,
    shell: shouldSpawnPackageManagerWithShell(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outputChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => outputChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => outputChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const output = Buffer.concat(outputChunks).toString("utf8").trim();
    throw new Error(
      `Failed to install "${input.packageName}" with ${packageManager} (exit ${exitCode}).` +
        (output.length > 0 ? `\n${output.slice(-2000)}` : ""),
    );
  }

  console.info(`[eve:dev] installed "${input.packageName}".`);
}

/**
 * Loads an optional engine package, auto-installing it into the
 * project when missing. Installs run only during `eve dev`; any other
 * process fails with the caller-supplied actionable message so
 * production deployments never mutate the application.
 */
export async function loadOptionalEnginePackage<T>(input: {
  readonly appRoot: string;
  readonly autoInstall: boolean;
  readonly importInstalledModule?: () => Promise<T>;
  readonly importModule: () => Promise<T>;
  readonly missingMessage: string;
  readonly packageName: string;
}): Promise<T> {
  try {
    return await input.importModule();
  } catch (importError) {
    if (!input.autoInstall || !isEveDevEnvironment()) {
      throw new Error(input.missingMessage, { cause: importError });
    }

    const importInstalledModule =
      input.importInstalledModule ??
      (async () =>
        await importInstalledEnginePackage<T>({
          appRoot: input.appRoot,
          packageName: input.packageName,
        }));
    const isInstalledModuleLoadable =
      input.importInstalledModule === undefined
        ? async () => await isInstalledEnginePackageLoadable(input)
        : async () => {
            try {
              await importInstalledModule();
              return true;
            } catch {
              return false;
            }
          };

    try {
      await withOptionalPackageInstallLock(input, async () => {
        if (await isInstalledModuleLoadable()) {
          return;
        }

        await installPackageIntoProject({
          appRoot: input.appRoot,
          packageName: input.packageName,
        });
      });
    } catch (installError) {
      throw new Error(
        `${input.missingMessage} Automatic installation failed: ${toMessage(installError)}`,
        { cause: installError },
      );
    }

    try {
      return await importInstalledModule();
    } catch (postInstallImportError) {
      throw new Error(
        `${input.missingMessage} Automatic installation completed, but "${input.packageName}" ` +
          `still could not be loaded from "${input.appRoot}". This usually means the package ` +
          "manager installed into a different workspace, node_modules is unavailable, or the " +
          `Node/package-manager environment changed while eve dev was running. Last load error: ${toMessage(postInstallImportError)}`,
        { cause: postInstallImportError },
      );
    }
  }
}

async function importInstalledEnginePackage<T>(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): Promise<T> {
  const entrypointHref = await resolveInstalledEnginePackageEntrypointHref(input);
  return (await import(entrypointHref)) as T;
}

async function isInstalledEnginePackageLoadable(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): Promise<boolean> {
  try {
    const entrypointHref = await resolveInstalledEnginePackageEntrypointHref(input);
    await importEntrypointInWorker(entrypointHref);
    return true;
  } catch {
    return false;
  }
}

async function resolveInstalledEnginePackageEntrypointHref(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): Promise<string> {
  const packageRoot = findInstalledPackageRoot(input);
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly exports?: unknown;
    readonly main?: unknown;
    readonly module?: unknown;
  };
  const entry = resolvePackageEntryPoint(packageJson);
  if (entry.startsWith("/")) {
    throw new Error(`Invalid absolute entrypoint for optional package "${input.packageName}".`);
  }
  return pathToFileURL(join(packageRoot, entry)).href;
}

async function importEntrypointInWorker(entrypointHref: string): Promise<void> {
  const worker = new Worker(
    `
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    await import(workerData.entrypointHref);
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
})();
`,
    {
      eval: true,
      workerData: { entrypointHref },
    },
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.off("error", handleError);
      worker.off("exit", handleExit);
      worker.off("message", handleMessage);
      void worker.terminate().catch(() => {});
      callback();
    };
    const handleError = (error: Error) => settle(() => reject(error));
    const handleExit = (code: number) => {
      if (code !== 0) {
        settle(() =>
          reject(
            new Error(`Optional dependency worker exited before loading module (code ${code}).`),
          ),
        );
      }
    };
    const handleMessage = (message: unknown) => {
      const result = message as { readonly ok?: unknown; readonly message?: unknown };
      settle(() => {
        if (result.ok === true) {
          resolve();
          return;
        }
        reject(
          new Error(
            typeof result.message === "string"
              ? result.message
              : "Optional dependency worker failed to load module.",
          ),
        );
      });
    };

    worker.once("error", handleError);
    worker.once("exit", handleExit);
    worker.once("message", handleMessage);
  });
}

function findInstalledPackageRoot(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): string {
  const packagePathSegments = input.packageName.split("/");
  const checkedPaths: string[] = [];
  let current = input.appRoot;

  for (;;) {
    const packageRoot = join(current, "node_modules", ...packagePathSegments);
    checkedPaths.push(packageRoot);
    if (existsSync(join(packageRoot, "package.json"))) {
      return packageRoot;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not find installed optional dependency "${input.packageName}". Checked: ${checkedPaths.join(", ")}`,
      );
    }
    current = parent;
  }
}

function resolvePackageEntryPoint(packageJson: {
  readonly exports?: unknown;
  readonly main?: unknown;
  readonly module?: unknown;
}): string {
  const dotExport = readDotExport(packageJson.exports);
  if (dotExport !== undefined) {
    return dotExport;
  }
  if (typeof packageJson.module === "string" && packageJson.module.length > 0) {
    return packageJson.module;
  }
  if (typeof packageJson.main === "string" && packageJson.main.length > 0) {
    return packageJson.main;
  }
  return "index.js";
}

function readDotExport(exportsValue: unknown): string | undefined {
  if (typeof exportsValue === "string" && exportsValue.length > 0) {
    return exportsValue;
  }
  if (typeof exportsValue !== "object" || exportsValue === null) {
    return undefined;
  }

  const dotExport =
    "." in exportsValue ? (exportsValue as { readonly ".": unknown })["."] : exportsValue;
  if (typeof dotExport === "string" && dotExport.length > 0) {
    return dotExport;
  }
  if (typeof dotExport !== "object" || dotExport === null) {
    return undefined;
  }

  const conditional = dotExport as { readonly import?: unknown; readonly default?: unknown };
  if (typeof conditional.import === "string" && conditional.import.length > 0) {
    return conditional.import;
  }
  if (typeof conditional.default === "string" && conditional.default.length > 0) {
    return conditional.default;
  }
  return undefined;
}

async function withOptionalPackageInstallLock(
  input: { readonly appRoot: string; readonly packageName: string },
  callback: () => Promise<void>,
): Promise<void> {
  const lockKey = `${input.appRoot}:${input.packageName}`;
  const pending = pendingOptionalPackageInstalls.get(lockKey);
  if (pending !== undefined) {
    await pending;
    return;
  }

  const promise = withOptionalPackageInstallFileLock(input, callback).finally(() => {
    pendingOptionalPackageInstalls.delete(lockKey);
  });
  pendingOptionalPackageInstalls.set(lockKey, promise);
  await promise;
}

async function withOptionalPackageInstallFileLock(
  input: { readonly appRoot: string; readonly packageName: string },
  callback: () => Promise<void>,
): Promise<void> {
  const lockPath = join(
    input.appRoot,
    ".eve",
    "optional-package-locks",
    `${sanitizeLockName(input.packageName)}.lock`,
  );
  await acquireLock(lockPath);
  try {
    await callback();
  } finally {
    await rm(lockPath, { force: true, recursive: true }).catch(() => {});
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid })}\n`,
      );
      return;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await waitForExistingLock(lockPath, startedAt);
    }
  }
}

async function waitForExistingLock(lockPath: string, startedAt: number): Promise<void> {
  const lockStat = await stat(lockPath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (lockStat === null) {
    return;
  }

  if (Date.now() - lockStat.mtimeMs > OPTIONAL_PACKAGE_STALE_LOCK_MS) {
    await rm(lockPath, { force: true, recursive: true }).catch(() => {});
    return;
  }

  if (Date.now() - startedAt > OPTIONAL_PACKAGE_LOCK_TIMEOUT_MS) {
    throw new Error(
      `Timed out waiting for optional package install lock "${lockPath}" after ${OPTIONAL_PACKAGE_LOCK_TIMEOUT_MS}ms.`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, OPTIONAL_PACKAGE_LOCK_POLL_MS));
}

function sanitizeLockName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * Windows package manager shims are commonly `.cmd` files, which plain
 * `spawn` does not resolve reliably without shell execution.
 */
function shouldSpawnPackageManagerWithShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
