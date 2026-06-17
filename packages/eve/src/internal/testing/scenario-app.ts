import {
  access,
  constants as fsConstants,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach } from "vitest";

import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";

const SCENARIO_APP_CLEANUP_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
const SCENARIO_AI_PACKAGE_VERSION = resolvePackageVersion("ai");

/**
 * Declarative description of a scenario-tier application.
 *
 * Scenario tests that need a real on-disk app (to run `eve build`, the Nitro
 * dev server, or `compileAgent` against real files) materialize a descriptor
 * into a fresh temporary directory via {@link materializeScenarioApp}. The
 * descriptor captures every file the test needs; the helper wires up the
 * package manifest, the eve tarball dependency, and (when requested) an
 * installed `node_modules/` tree.
 *
 * Descriptors are the single source of truth for fixture content — the
 * former `test/fixtures/**` trees were deleted in favour of this model.
 */
export interface ScenarioAppDescriptor {
  /**
   * Stable slug used as the temp-directory prefix and the `package.json#name`.
   * Keep this short and kebab-case.
   */
  readonly name: string;
  /**
   * Files to write, keyed by path relative to the app root. Use POSIX-style
   * separators. Parent directories are created automatically.
   */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Directories to create without any files. Parents of paths in {@link files}
   * are inferred automatically; list explicit empty directories here.
   */
  readonly directories?: readonly string[];
  /**
   * Additional dependencies installed alongside `eve`. Keys are
   * package names, values are npm version specifiers or `file:` specifiers.
   *
   * `eve` is always wired via the test tarball and must not be
   * listed here. The AI SDK peer dependency is wired from the workspace's
   * installed version by default unless a descriptor overrides `ai`.
   */
  readonly dependencies?: Readonly<Record<string, string>>;
  /**
   * Optional `package.json#type` value. Defaults to `"module"`.
   */
  readonly packageType?: "module" | "commonjs";
  /**
   * When `true`, the materialized app has a populated `node_modules/` tree
   * containing the `eve` tarball and the requested dependencies.
   *
   * Set this for scenarios that spawn subprocesses (`eve dev`, `eve build`)
   * or start the Nitro dev server — anything that resolves `eve`
   * at runtime. Compile-only tests can leave this `false` (the default) to
   * skip the pnpm-install cost. pnpm's content-addressable store keeps the
   * second-and-onwards install in the same vitest worker fast (~1s) without
   * us having to maintain a bespoke template-then-copy cache.
   */
  readonly installDependencies?: boolean;
}

/**
 * Handle to a materialized scenario app. Callers must call
 * {@link ScenarioApp.cleanup} in `afterEach` / `afterAll`.
 */
export interface ScenarioApp {
  /** Absolute filesystem path to the materialized app root. */
  readonly appRoot: string;
  /** Removes the app root and all transient artifacts. */
  cleanup(): Promise<void>;
}

/**
 * Materializes {@link ScenarioAppDescriptor} under `os.tmpdir()` and returns
 * a handle pointing at the fresh app root. Each call produces an isolated
 * root so tests may freely mutate files without cross-test interference.
 *
 * `eve` is installed from a worker-local tarball cached across
 * invocations. When {@link ScenarioAppDescriptor.installDependencies} is
 * `true`, this function additionally runs `pnpm install` directly in the
 * fresh app root. pnpm's content-addressable store keeps repeat installs
 * cheap, so we skip the bespoke template-then-copy caching that previously
 * tripped over Windows directory junctions in `fs.cp`.
 */
export async function materializeScenarioApp(
  descriptor: ScenarioAppDescriptor,
): Promise<ScenarioApp> {
  const appRoot = await mkdtemp(join(tmpdir(), `eve-scenario-${descriptor.name}-`));

  try {
    await writePackageManifest({
      appRoot,
      descriptor,
    });
    await writeDescriptorDirectories({
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

/**
 * Registers an `afterEach` cleanup for scenario apps created inside a test
 * block. Returns a factory that pushes each materialization onto the shared
 * cleanup list.
 */
export function useScenarioApp(): (descriptor: ScenarioAppDescriptor) => Promise<ScenarioApp> {
  const materialized: ScenarioApp[] = [];

  afterEach(async () => {
    await Promise.all(
      materialized.splice(0).map(async (app) => {
        try {
          await app.cleanup();
        } catch {
          // Best-effort cleanup; a leaked tmpdir must not fail the run.
        }
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
    type: input.descriptor.packageType ?? "module",
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

async function writeDescriptorDirectories(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
  const directories = input.descriptor.directories ?? [];

  await Promise.all(
    directories.map(async (relativePath) => {
      await mkdir(join(input.appRoot, relativePath), {
        recursive: true,
      });
    }),
  );
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

/**
 * Runs `pnpm install` directly inside the materialized app root. The
 * `package.json` and `eve` tarball were already written by
 * {@link writePackageManifest}, so all this needs to do is invoke pnpm.
 *
 * We deliberately do *not* maintain a per-test "template" `node_modules/`
 * that we copy across apps. The previous template-then-copy optimization
 * tripped over `fs.cp`'s handling of pnpm's directory junctions on Windows
 * (relative `node_modules/.pnpm/<pkg>/node_modules/<dep>` links did not
 * survive the round-trip), and pnpm's content-addressable store already
 * keeps subsequent installs in the same worker fast enough that the
 * bespoke cache wasn't pulling its weight.
 */
async function installScenarioDependencies(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
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

const EVE_SCENARIO_EVE_TARBALL_PATH_ENV = "EVE_SCENARIO_EVE_TARBALL_PATH";

let cachedScenarioEveTarballPromise: Promise<string> | null = null;

/**
 * Returns the on-disk path to the eve tarball used by scenario apps.
 *
 * When the scenario vitest config's `globalSetup`
 * (`test/setup/pack-scenario-tarball.ts`) has run, the tarball is packed
 * once upfront to a shared location and every worker reuses it via the
 * `EVE_SCENARIO_EVE_TARBALL_PATH` env var. When the env var is missing
 * (e.g. a developer invokes `vitest` against a single scenario file
 * directly), this falls back to packing into a worker-local cache
 * directory, which is safe because only one worker is running.
 */
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

  await rm(tarballsRoot, {
    force: true,
    recursive: true,
  });
  await mkdir(tarballsRoot, {
    recursive: true,
  });

  const packageRoot = resolvePackageRoot();

  await runPnpmCommand({
    args: ["pack", "--pack-destination", tarballsRoot],
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

/**
 * Returns a per-worker cache directory used to store the eve tarball and the
 * installed dependency templates. The directory is created on demand and
 * scoped by `VITEST_WORKER_ID` so concurrent workers cannot corrupt each
 * other's caches.
 */
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
