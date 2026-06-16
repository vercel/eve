import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Environment flag set by `eve dev` so runtime code can distinguish the
 * interactive development server from production processes. Optional
 * engine packages are auto-installed only when this is set.
 */
export const EVE_DEV_ENV_FLAG = "EVE_DEV";

/**
 * Reports whether this process belongs to an `eve dev` session.
 */
export function isEveDevEnvironment(): boolean {
  return process.env[EVE_DEV_ENV_FLAG] === "1";
}

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

    try {
      await installPackageIntoProject({
        appRoot: input.appRoot,
        packageName: input.packageName,
      });
    } catch (installError) {
      throw new Error(
        `${input.missingMessage} Automatic installation failed: ${toMessage(installError)}`,
        { cause: installError },
      );
    }

    return await input.importModule();
  }
}

/**
 * Windows package manager shims are commonly `.cmd` files, which plain
 * `spawn` does not resolve reliably without shell execution.
 */
function shouldSpawnPackageManagerWithShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
