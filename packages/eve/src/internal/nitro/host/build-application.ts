import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { build as buildNitro, copyPublicAssets, prepare, prerender } from "nitro/builder";
import type { Nitro } from "nitro/types";

import { resolvePackageRoot } from "#internal/application/package.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import { resolveNitroSurfaceOutputDirectory } from "#internal/application/paths.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { normalizeEveVercelFunctionOutput } from "#internal/workflow-bundle/vercel-workflow-output.js";
import { createApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { emitVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import { prepareApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { runVercelBuildPrewarm } from "#internal/nitro/host/vercel-build-prewarm.js";
import type { NitroBuildSurface, PreparedApplicationHost } from "#internal/nitro/host/types.js";
import { findClosestVercelOutputDirectory } from "#shared/vercel-output-directory.js";

function trimTrailingSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeEntrypoint(rootDir: string, entrypoint: unknown): string | null {
  if (typeof entrypoint !== "string" || entrypoint.trim().length === 0) {
    return null;
  }

  return resolve(rootDir, entrypoint);
}

function normalizeServicePrefix(service: Record<string, unknown>): string {
  if (typeof service.routePrefix === "string") {
    return service.routePrefix.trim();
  }

  if (typeof service.mount === "string") {
    return service.mount.trim();
  }

  if (
    isRecord(service.mount) &&
    typeof service.mount.path === "string" &&
    service.mount.path.trim().length > 0
  ) {
    return service.mount.path.trim();
  }

  return "";
}

/**
 * Resolve the route prefix an eve service is mounted under when it is
 * co-deployed behind a host web service (Next.js, Nuxt, SvelteKit etc.).
 *
 * Any service whose framework is not `eve` is treated as a host that proxies
 * eve's transport routes behind a prefix. A standalone eve deployment (no host
 * service) returns `undefined` so its output stays routable at the root.
 */
function resolveCoDeployedEveServicePrefix(input: {
  appRoot: string;
  configRoot: string;
  config: unknown;
}): string | undefined {
  if (!isRecord(input.config) || !isRecord(input.config.experimentalServices)) {
    return undefined;
  }

  let hasHostService = false;
  let servicePrefix: string | undefined;

  for (const service of Object.values(input.config.experimentalServices)) {
    if (!isRecord(service)) {
      continue;
    }

    if (service.framework !== "eve") {
      hasHostService = true;
      continue;
    }

    const eveEntrypoint = normalizeEntrypoint(input.configRoot, service.entrypoint);
    const routePrefix = normalizeServicePrefix(service);

    if (eveEntrypoint === input.appRoot && routePrefix.length > 0 && routePrefix !== "/") {
      servicePrefix = routePrefix;
    }
  }

  return hasHostService ? servicePrefix : undefined;
}

async function resolveCoDeployedEveServicePrefixForVercelFunctionOutput(
  appRoot: string,
): Promise<string | undefined> {
  const outputDirectory = await findClosestVercelOutputDirectory(appRoot);

  if (outputDirectory !== undefined) {
    try {
      const config = JSON.parse(
        await readFile(join(outputDirectory, "config.json"), "utf8"),
      ) as unknown;
      const servicePrefix = resolveCoDeployedEveServicePrefix({
        appRoot,
        configRoot: appRoot,
        config,
      });

      if (servicePrefix !== undefined) {
        return servicePrefix;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  let currentDir = appRoot;

  while (true) {
    for (const configPath of [
      join(currentDir, "vercel.json"),
      join(currentDir, ".vercel", "output", "config.json"),
    ]) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
        const configRoot = configPath.endsWith("vercel.json") ? currentDir : appRoot;

        const servicePrefix = resolveCoDeployedEveServicePrefix({
          appRoot,
          configRoot,
          config,
        });

        if (servicePrefix !== undefined) {
          return servicePrefix;
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

async function readVercelServerRuntime(outputDir: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(
      await readFile(join(outputDir, "functions", "__server.func", ".vc-config.json"), "utf8"),
    ) as {
      runtime?: string;
    };

    return config.runtime;
  } catch {
    return undefined;
  }
}

async function emitVercelWorkflowFunctions(input: {
  appRoot: string;
  compiledArtifactsBootstrapPath: string;
  flowNitroOutputDir: string;
  outputDir: string;
  workflowBuildDir: string;
}): Promise<void> {
  const builder = new WorkflowBundleBuilder({
    appRoot: input.appRoot,
    compiledArtifactsBootstrapPath: input.compiledArtifactsBootstrapPath,
    outDir: input.workflowBuildDir,
    rootDir: resolvePackageRoot(),
    watch: false,
  });
  const runtime = await readVercelServerRuntime(input.outputDir);

  await builder.buildVercelOutput({
    flowNitroOutputDir: input.flowNitroOutputDir,
    outputDir: input.outputDir,
    runtime,
  });
}

async function buildNitroOutput(nitro: Nitro): Promise<string> {
  const outputDirectory = trimTrailingSlash(nitro.options.output.dir);

  await prepareEveVersionedCacheDirectory(outputDirectory);
  await prepare(nitro);
  await copyPublicAssets(nitro);
  await prerender(nitro);
  await buildNitro(nitro);
  await writeEveVersionedCacheMetadata(outputDirectory);

  return outputDirectory;
}

async function buildVercelNitroSurface(
  preparedHost: PreparedApplicationHost,
  surface: Exclude<NitroBuildSurface, "all">,
): Promise<string> {
  const nitro = await createApplicationNitro(preparedHost, false, {
    outputDir: resolveNitroSurfaceOutputDirectory(preparedHost.appRoot, surface),
    surface,
  });

  try {
    return await buildNitroOutput(nitro);
  } finally {
    await nitro.close();
  }
}

/**
 * Builds the production Nitro output for an eve application.
 */
export async function buildApplication(rootDir: string): Promise<string> {
  const preparedHost = await prepareApplicationHost(rootDir);

  if (!process.env.VERCEL) {
    const nitro = await createApplicationNitro(preparedHost, false);

    try {
      const outputDirectory = await buildNitroOutput(nitro);
      await emitVercelAgentSummary({
        manifest: preparedHost.compileResult.manifest,
        appRoot: preparedHost.appRoot,
      });
      return outputDirectory;
    } finally {
      await nitro.close();
    }
  }

  const servicePrefix = await resolveCoDeployedEveServicePrefixForVercelFunctionOutput(
    preparedHost.appRoot,
  );
  const nitro = await createApplicationNitro(preparedHost, false, {
    surface: "app",
  });

  try {
    const outputDirectory = await buildNitroOutput(nitro);
    // Run sandbox prewarm before emitting the workflow functions so a
    // prewarm failure aborts the build before we spend time bundling
    // function output that we would never deploy.
    await runVercelBuildPrewarm({
      appRoot: preparedHost.appRoot,
      log(message) {
        console.log(message);
      },
    });
    const flowNitroOutputDir = await buildVercelNitroSurface(preparedHost, "flow");
    await emitVercelWorkflowFunctions({
      appRoot: preparedHost.appRoot,
      compiledArtifactsBootstrapPath: preparedHost.compiledArtifacts.bootstrapPath,
      flowNitroOutputDir,
      outputDir: outputDirectory,
      workflowBuildDir: preparedHost.workflowBuildDir,
    });
    if (servicePrefix !== undefined) {
      await normalizeEveVercelFunctionOutput(outputDirectory, {
        servicePrefix,
      });
    }
    await emitVercelAgentSummary({
      manifest: preparedHost.compileResult.manifest,
      appRoot: preparedHost.appRoot,
    });

    return outputDirectory;
  } finally {
    await nitro.close();
  }
}
