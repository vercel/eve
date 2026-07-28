import { join } from "node:path";

import { createNitro } from "nitro/builder";
import type { Nitro } from "nitro/types";

import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import {
  applyProductionEveNitroContribution,
  configureInitialStandaloneDevelopmentEveNitroContribution,
} from "#internal/nitro/host/apply-eve-nitro-contribution.js";
import { configureStandaloneNitroShellRoutes } from "#internal/nitro/host/configure-nitro-routes.js";
import { applyEveCronHandlerRoute } from "#internal/nitro/host/cron-handler-route.js";
import { createEveNitroContribution } from "#internal/nitro/host/eve-nitro-contribution.js";
import { mergeEveNitroConfig } from "#internal/nitro/host/merge-eve-nitro-config.js";
import type {
  NitroBuildSurface,
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";
import { createEveVercelOptions } from "#internal/nitro/host/vercel-build-output-config.js";

function resolveProductionNitroPreset(): "vercel" | undefined {
  return process.env.VERCEL ? "vercel" : undefined;
}

function createDevelopmentWatchOptions(appRoot: string): { ignored: string[] } {
  return {
    // eve's authored-source watcher owns app code rebuilds. If Nitro/Rollup
    // also watches those files it can reload the worker while a workflow
    // stream is waiting on a tool result, which surfaces as ECONNRESET.
    ignored: [appRoot, join(appRoot, "**")],
  };
}

async function closeFailedNitroCandidate(nitro: Nitro, error: unknown): Promise<never> {
  try {
    await nitro.close();
  } catch (closeError) {
    throw new AggregateError(
      [error, closeError],
      "Failed to configure and close the Nitro host candidate.",
      { cause: error },
    );
  }

  throw error;
}

/** Creates one isolated Nitro host candidate for `eve dev`. */
export async function createDevelopmentApplicationNitro(
  preparedHost: PreparedDevelopmentApplicationHost,
): Promise<Nitro> {
  const nitroBuildDir = preparedHost.workspace.nitroBuildDir;
  const contribution = createEveNitroContribution(preparedHost, {
    mode: "development",
    preset: undefined,
    surface: "all",
  });

  await prepareEveVersionedCacheDirectory(nitroBuildDir);
  const nitro = await createNitro(
    mergeEveNitroConfig(
      {
        _cli: { command: "dev" },
        buildDir: nitroBuildDir,
        dev: true,
        logLevel: 1,
        output: { dir: preparedHost.workspace.nitroOutputDir },
        publicAssets: [],
        rootDir: preparedHost.appRoot,
        serverDir: false,
        vercel: createEveVercelOptions({
          agentName: preparedHost.compileResult.manifest.config.name,
          enabled: false,
        }),
        watchOptions: createDevelopmentWatchOptions(preparedHost.appRoot),
      },
      contribution,
    ),
    { watch: true },
  );
  try {
    await writeEveVersionedCacheMetadata(nitroBuildDir);
    await configureInitialStandaloneDevelopmentEveNitroContribution(nitro, contribution);
    configureStandaloneNitroShellRoutes(nitro, preparedHost);
    nitro.routing.sync();

    return nitro;
  } catch (error) {
    return await closeFailedNitroCandidate(nitro, error);
  }
}

interface ProductionApplicationNitroOptions {
  readonly buildDir: string;
  readonly outputDir: string;
  readonly publicRoutePrefix?: string;
  readonly surface?: NitroBuildSurface;
}

/**
 * Creates a build-mode Nitro host. Standalone builds use the complete route
 * surface, while internal callers may narrow it for isolated build outputs.
 * `buildDir` and `outputDir` remain standalone-host policy.
 */
export async function createProductionApplicationNitro(
  preparedHost: PreparedApplicationHost,
  options: ProductionApplicationNitroOptions,
): Promise<Nitro> {
  const preset = resolveProductionNitroPreset();
  const contribution = createEveNitroContribution(preparedHost, {
    mode: "production",
    preset,
    surface: options.surface ?? "all",
  });

  await prepareEveVersionedCacheDirectory(options.buildDir);
  const nitro = await createNitro(
    mergeEveNitroConfig(
      {
        _cli: { command: "build" },
        buildDir: options.buildDir,
        dev: false,
        output: { dir: options.outputDir },
        preset,
        publicAssets: [],
        rootDir: preparedHost.appRoot,
        serverDir: false,
        vercel: createEveVercelOptions({
          agentName: preparedHost.compileResult.manifest.config.name,
          enabled: preset === "vercel" && contribution.applicationRoutes,
          publicRoutePrefix: options.publicRoutePrefix,
        }),
      },
      contribution,
    ),
  );
  try {
    await writeEveVersionedCacheMetadata(options.buildDir);
    await applyProductionEveNitroContribution(nitro, contribution);
    if (contribution.applicationRoutes) {
      configureStandaloneNitroShellRoutes(nitro, preparedHost);
      if (preparedHost.scheduleRegistrations.length > 0) {
        applyEveCronHandlerRoute(nitro);
      }
    }
    nitro.routing.sync();

    return nitro;
  } catch (error) {
    return await closeFailedNitroCandidate(nitro, error);
  }
}
