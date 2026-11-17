import {
  access,
  constants as fsConstants,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach } from "vitest";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";

const SCENARIO_APP_CLEANUP_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
const SCENARIO_AI_PACKAGE_VERSION = resolvePackageVersion("ai");

export interface ScenarioAppDescriptor {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly installDependencies?: boolean;
  readonly packageManager?: "bun" | "npm" | "pnpm";
}

interface ScenarioApp {
  readonly appRoot: string;
  cleanup(): Promise<void>;
}

export async function materializeScenarioApp(
  descriptor: ScenarioAppDescriptor,
): Promise<ScenarioApp> {
  const appRoot = await mkdtemp(join(tmpdir(), `eve-scenario-${descriptor.name}-`));

  try {
    await writePackageManifest({
      appRoot,
      descriptor,
    });
    await writeDescriptorFiles({
      appRoot,
      descriptor,
    });

    if (descriptor.installDependencies === true) {
      await installScenarioDependencies({
        appRoot,
        descriptor,
      });
    }

    return {
      appRoot,
      async cleanup(): Promise<void> {
        await rm(appRoot, {
          force: true,
          maxRetries: 5,
          recursive: true,
          retryDelay: 200,
        });
      },
    };
  } catch (error) {
    await rm(appRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });

    throw error;
  }
}

export function useScenarioApp(): (descriptor: ScenarioAppDescriptor) => Promise<ScenarioApp> {
  const materialized: ScenarioApp[] = [];

  afterEach(async () => {
    await Promise.all(
      materialized.splice(0).map(async (app) => {
        try {
          await app.cleanup();
        } catch {}
      }),
    );
  }, SCENARIO_APP_CLEANUP_TIMEOUT_MS);

  return async (descriptor) => {
    const app = await materializeScenarioApp(descriptor);
    materialized.push(app);
    return app;
  };
}

async function writePackageManifest(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
  const tarballFileName = await resolveScenarioEveTarballFileName();
  const packageJson: Record<string, unknown> = {
    dependencies: {
      ai: SCENARIO_AI_PACKAGE_VERSION,
      [EVE_PACKAGE_NAME]: `file:./${tarballFileName}`,
      ...input.descriptor.dependencies,
    },
    name: input.descriptor.name,
    private: true,
    type: "module",
  };

  await writeFile(
    join(input.appRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );

  await cp(await ensureScenarioEveTarballPath(), join(input.appRoot, tarballFileName));
}

function resolvePackageVersion(packageName: string): string {
  const manifest = require(`${packageName}/package.json`) as { version?: unknown };

  if (typeof manifest.version !== "string") {
    throw new Error(`Expected ${packageName}/package.json to contain a string version.`);
  }

  return manifest.version;
}

export async function resolveScenarioPackageVersion(packageName: string): Promise<string> {
  let currentPath = dirname(require.resolve(packageName));

  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(currentPath, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };

      if (manifest.name === packageName && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Could not find the installed package manifest for ${packageName}.`);
    }
    currentPath = parentPath;
  }
}

async function writeDescriptorFiles(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
  const entries = Object.entries(input.descriptor.files);

  await Promise.all(
    entries.map(async ([relativePath, contents]) => {
      const destinationPath = join(input.appRoot, relativePath);

      await mkdir(dirname(destinationPath), {
        recursive: true,
      });
      await writeFile(destinationPath, contents, "utf8");
    }),
  );
}

async function installScenarioDependencies(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
  if (input.descriptor.packageManager === "npm") {
    await writeFile(
      join(input.appRoot, ".npmrc"),
      "registry=https://registry.npmjs.org/\nmin-release-age=0\n",
    );
    await runInstallCommand(input.appRoot, "npm", [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--prefer-online",
    ]);
    return;
  }
  if (input.descriptor.packageManager === "bun") {
    await writeFile(
      join(input.appRoot, "bunfig.toml"),
      ["[install]", "minimumReleaseAge = 0", ""].join("\n"),
    );
    await writeFile(join(input.appRoot, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    await runInstallCommand(input.appRoot, "bun", ["install", "--ignore-scripts"]);
    return;
  }

  await writeFile(join(input.appRoot, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  await runPnpmCommand({
    args: [
      "install",
      "--no-frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
      "--config.confirm-modules-purge=false",
      "--config.minimum-release-age=0",
    ],
    cwd: input.appRoot,
  });
}

const runFile = promisify(execFile);

async function runInstallCommand(
  appRoot: string,
  command: "bun" | "npm",
  args: readonly string[],
): Promise<void> {
  try {
    await runFile(command, [...args], {
      cwd: appRoot,
      env: {
        ...process.env,
        NPM_CONFIG_USERCONFIG: join(appRoot, ".npmrc"),
      },
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (error) {
    const failure = error as { readonly stderr?: unknown; readonly stdout?: unknown };
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `cwd: ${appRoot}`,
        `stdout:\n${typeof failure.stdout === "string" ? failure.stdout : ""}`,
        `stderr:\n${typeof failure.stderr === "string" ? failure.stderr : ""}`,
      ].join("\n\n"),
      { cause: error },
    );
  }
}

const EVE_SCENARIO_EVE_TARBALL_PATH_ENV = "EVE_SCENARIO_EVE_TARBALL_PATH";

let cachedScenarioEveTarballPromise: Promise<string> | null = null;

export async function ensureScenarioEveTarballPath(): Promise<string> {
  cachedScenarioEveTarballPromise ??= resolveOrPackScenarioEveTarball();
  return await cachedScenarioEveTarballPromise;
}

async function resolveOrPackScenarioEveTarball(): Promise<string> {
  const sharedTarballPath = process.env[EVE_SCENARIO_EVE_TARBALL_PATH_ENV];

  if (sharedTarballPath !== undefined && (await isFilePresent(sharedTarballPath))) {
    return sharedTarballPath;
  }

  return await packScenarioEveTarball();
}

async function packScenarioEveTarball(): Promise<string> {
  const cacheRoot = await resolveScenarioWorkerCacheDirectory();
  const tarballsRoot = join(cacheRoot, "tarballs");
  const packageRoot = resolvePackageRoot();
  const prebuiltEntryPath = join(packageRoot, "dist", "src", "index.js");

  if (!(await isFilePresent(prebuiltEntryPath))) {
    throw new Error(
      `Scenario tests require a prebuilt eve package. Run "pnpm build" first. Missing: ${prebuiltEntryPath}`,
    );
  }

  await rm(tarballsRoot, {
    force: true,
    recursive: true,
  });
  await mkdir(tarballsRoot, {
    recursive: true,
  });

  await runPnpmCommand({
    args: ["pack", "--config.ignore-scripts=true", "--pack-destination", tarballsRoot],
    cwd: packageRoot,
  });

  const entries = await readdir(tarballsRoot);
  const tarballPrefix = EVE_PACKAGE_NAME.replace(/^@/, "").replaceAll("/", "-");
  const latestTarballName = entries
    .filter((entry) => entry.startsWith(`${tarballPrefix}-`) && entry.endsWith(".tgz"))
    .sort((left, right) => left.localeCompare(right))
    .at(-1);

  if (latestTarballName === undefined) {
    throw new Error(
      `Expected pnpm pack to emit a ${tarballPrefix}-*.tgz tarball in "${tarballsRoot}".`,
    );
  }

  return join(tarballsRoot, latestTarballName);
}

let cachedScenarioEveTarballFileNamePromise: Promise<string> | null = null;

async function resolveScenarioEveTarballFileName(): Promise<string> {
  cachedScenarioEveTarballFileNamePromise ??= (async () => {
    const tarballPath = await ensureScenarioEveTarballPath();
    return basename(tarballPath);
  })();

  return await cachedScenarioEveTarballFileNamePromise;
}

let cachedScenarioWorkerCacheDirectoryPromise: Promise<string> | null = null;

async function resolveScenarioWorkerCacheDirectory(): Promise<string> {
  cachedScenarioWorkerCacheDirectoryPromise ??= (async () => {
    const workerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "main";
    const root = join(tmpdir(), "eve-scenario-cache", `worker-${workerId}`);

    await mkdir(root, {
      recursive: true,
    });
    return root;
  })();

  return await cachedScenarioWorkerCacheDirectoryPromise;
}

async function isFilePresent(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
