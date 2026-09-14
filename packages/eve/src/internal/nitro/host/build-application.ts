import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { build as buildNitro, copyPublicAssets, prepare, prerender } from "nitro/builder";
import type { Nitro } from "nitro/types";

import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
  type ApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import {
  ApplicationBuildProfiler,
  createApplicationBuildProfile,
  measureApplicationBuildOutput,
  writeApplicationBuildProfile,
} from "#internal/application/build-profile.js";
import {
  publishApplicationBuildArtifacts,
  RecoverablePublicationError,
} from "#internal/application/output-publication.js";
import { stageProductionCompilerArtifacts } from "#internal/application/production-compiler-artifacts.js";
import {
  materializeVercelWorkflowFunctionOutput,
  normalizeEveVercelFunctionOutput,
} from "#internal/workflow-bundle/vercel-workflow-output.js";
import { createProductionApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { emitVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import { tryReadExtensionBuildConfig } from "#internal/nitro/host/build-extension.js";
import { copyHostMiddlewareFunctions } from "#internal/nitro/host/copy-host-middleware.js";
import { normalizeVercelServiceCrons } from "#internal/nitro/host/normalize-vercel-service-crons.js";
import { prepareProductionApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { runVercelBuildPrewarm } from "#internal/nitro/host/vercel-build-prewarm.js";
import type { ApplicationBuildOptions } from "#internal/nitro/host/types.js";
import { findClosestVercelOutputDirectory } from "#shared/vercel-output-directory.js";
import { toErrorMessage } from "#shared/errors.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { resolveEveServicePrefixByRoot } from "#internal/vercel/vercel-service-config-operations.js";
import { parseVercelServicesConfig } from "#internal/vercel/vercel-services-config.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { isObject } from "#shared/guards.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { normalizePublicRoutePrefix } from "#shared/public-route-prefix.js";

function trimTrailingSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

async function measureBuildPhase<T>(
  profiler: ApplicationBuildProfiler | undefined,
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  return profiler === undefined ? operation() : profiler.measure(name, operation);
}

function isPathInside(directoryPath: string, candidatePath: string): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function assertProfileOutputOutsideBuildOutput(
  profileOutputPath: string | undefined,
  outputDirectory: string,
): void {
  if (profileOutputPath !== undefined && isPathInside(outputDirectory, profileOutputPath)) {
    throw new Error(
      `Build profile path ${profileOutputPath} must be outside the published output directory ${outputDirectory}.`,
    );
  }
}

async function writeOptionalApplicationBuildProfile(input: {
  readonly outputDirectory: string;
  readonly profileOutputPath: string;
  readonly profiler: ApplicationBuildProfiler;
}): Promise<void> {
  try {
    assertProfileOutputOutsideBuildOutput(input.profileOutputPath, input.outputDirectory);
    const timing = input.profiler.finish();
    const output = await measureApplicationBuildOutput(input.outputDirectory);
    await writeApplicationBuildProfile(
      input.profileOutputPath,
      createApplicationBuildProfile({
        output,
        target: process.env.VERCEL ? "vercel" : "local",
        timing,
      }),
    );
  } catch (error) {
    console.warn(
      `eve: failed to write optional build profile to ${input.profileOutputPath}; continuing with the published build output: ${toErrorMessage(error)}`,
    );
  }
}

async function resolveEveServicePrefixForVercelFunctionOutput(
  appRoot: string,
  agentRoot: string,
): Promise<string | undefined> {
  const appRoots = Array.from(new Set([resolve(appRoot), resolve(agentRoot)]));
  const outputDirectory = await findClosestVercelOutputDirectory(appRoot);

  if (outputDirectory !== undefined) {
    try {
      const configPath = join(outputDirectory, "config.json");
      const config = parseVercelServicesConfig(
        JSON.parse(await readFile(configPath, "utf8")) as unknown,
        configPath,
      );
      const servicePrefix = resolveEveServicePrefixByRoot({
        appRoots,
        configRoot: await resolveVercelOutputConfigRoot(outputDirectory),
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
        const config = parseVercelServicesConfig(
          JSON.parse(await readFile(configPath, "utf8")) as unknown,
          configPath,
        );
        const configRoot = configPath.endsWith("vercel.json")
          ? currentDir
          : await resolveVercelOutputConfigRoot(dirname(configPath));

        const servicePrefix = resolveEveServicePrefixByRoot({
          appRoots,
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

async function resolveVercelOutputConfigRoot(outputDirectory: string): Promise<string> {
  const projectRoot = dirname(dirname(outputDirectory));

  try {
    const projectConfig = JSON.parse(
      await readFile(join(projectRoot, ".vercel", "project.json"), "utf8"),
    ) as unknown;

    if (isObject(projectConfig) && isObject(projectConfig.settings)) {
      const rootDirectory = projectConfig.settings.rootDirectory;
      if (typeof rootDirectory === "string" && rootDirectory.trim().length > 0) {
        return resolve(projectRoot, rootDirectory);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return projectRoot;
}

async function buildNitroOutput(
  nitro: Nitro,
  profiler: ApplicationBuildProfiler | undefined,
  phasePrefix: string,
): Promise<string> {
  const outputDirectory = trimTrailingSlash(nitro.options.output.dir);

  await measureBuildPhase(profiler, `${phasePrefix}.cache.prepare`, () =>
    prepareEveVersionedCacheDirectory(outputDirectory),
  );
  await measureBuildPhase(profiler, `${phasePrefix}.prepare`, () => prepare(nitro));
  await measureBuildPhase(profiler, `${phasePrefix}.public-assets`, () => copyPublicAssets(nitro));
  await measureBuildPhase(profiler, `${phasePrefix}.prerender`, () => prerender(nitro));
  await measureBuildPhase(profiler, `${phasePrefix}.bundle`, () => buildNitro(nitro));
  await measureBuildPhase(profiler, `${phasePrefix}.cache.write`, () =>
    writeEveVersionedCacheMetadata(outputDirectory),
  );

  return outputDirectory;
}

/**
 * Builds the production Nitro output for an eve application.
 */
export async function buildApplication(
  rootDir: string,
  options: ApplicationBuildOptions,
): Promise<string> {
  const profileOutputPath =
    options.profileOutputPath === undefined ? undefined : resolve(options.profileOutputPath);
  const profiler = profileOutputPath === undefined ? undefined : new ApplicationBuildProfiler();

  // Extension packages use `eve extension build`. Keep agent `eve build` agent-only
  // so a mistaken run fails with a clear redirect instead of a half-Nitro path.
  const extensionBuild = await measureBuildPhase(profiler, "extension.check", () =>
    tryReadExtensionBuildConfig(rootDir),
  );
  if (extensionBuild !== null) {
    throw new Error(
      `Package "${extensionBuild.packageName}" is an eve extension. Run \`eve extension build\` instead of \`eve build\`.`,
    );
  }

  const project = await measureBuildPhase(profiler, "project.resolve", () =>
    resolveDiscoveryProject(rootDir),
  );
  const workspace = await measureBuildPhase(profiler, "workspace.create", () =>
    createApplicationBuildWorkspace(
      project.appRoot,
      options.vercelServiceOutput?.serviceOutputDirectory,
    ),
  );

  // A recoverable publication failure leaves the lock journal pointing at
  // staged artifacts inside this workspace; the next build's recovery
  // consumes and then removes it. Deleting it now would strand the journal.
  let preserveWorkspaceForRecovery = false;
  let outputDirectory: string;
  try {
    outputDirectory = await buildApplicationInWorkspace(workspace, options, profiler);
  } catch (error) {
    preserveWorkspaceForRecovery = error instanceof RecoverablePublicationError;
    throw error;
  } finally {
    if (!preserveWorkspaceForRecovery) {
      await measureBuildPhase(profiler, "workspace.remove", () =>
        removeApplicationBuildWorkspace(workspace),
      );
    }
  }

  if (profiler !== undefined && profileOutputPath !== undefined) {
    await writeOptionalApplicationBuildProfile({
      outputDirectory,
      profileOutputPath,
      profiler,
    });
  }

  return outputDirectory;
}

async function buildApplicationInWorkspace(
  workspace: ApplicationBuildWorkspace,
  options: ApplicationBuildOptions,
  profiler: ApplicationBuildProfiler | undefined,
): Promise<string> {
  const preparedHost = await measureBuildPhase(profiler, "host.prepare", () =>
    prepareProductionApplicationHost(workspace),
  );
  const isVercelBuild = Boolean(process.env.VERCEL);

  const servicePrefix = isVercelBuild
    ? await measureBuildPhase(profiler, "vercel.service-prefix.resolve", () =>
        resolveEveServicePrefixForVercelFunctionOutput(
          preparedHost.appRoot,
          preparedHost.compileResult.project.agentRoot,
        ),
      )
    : undefined;
  // A service routed at the protocol path has no additional public mount.
  // Keep servicePrefix intact for function-output routing below.
  const normalizedServicePrefix = normalizePublicRoutePrefix(servicePrefix);
  const inferredPublicRoutePrefix =
    normalizedServicePrefix === EVE_ROUTE_PREFIX ? undefined : normalizedServicePrefix;
  if (
    options.publicRoutePrefix !== undefined &&
    inferredPublicRoutePrefix !== undefined &&
    options.publicRoutePrefix !== inferredPublicRoutePrefix
  ) {
    throw new Error(
      `EVE_PUBLIC_ROUTE_PREFIX ${JSON.stringify(options.publicRoutePrefix)} conflicts with the configured Vercel service prefix ${JSON.stringify(servicePrefix)}.`,
    );
  }
  const publicRoutePrefix = options.publicRoutePrefix ?? inferredPublicRoutePrefix;
  const nitro = await measureBuildPhase(profiler, "nitro.create", () =>
    createProductionApplicationNitro(preparedHost, {
      buildDir: workspace.nitro.buildDir,
      outputDir: workspace.publication.output.stagedDir,
      publicRoutePrefix,
      workspaceMember: options.workspaceMember,
    }),
  );

  try {
    // Run sandbox prewarm before bundling so a prewarm failure aborts the
    // build before we spend time producing output we would never deploy.
    if (isVercelBuild && !options.skipVercelSandboxPrewarm) {
      await measureBuildPhase(profiler, "sandbox.prewarm", () =>
        runVercelBuildPrewarm({
          appRoot: preparedHost.appRoot,
          compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(
            workspace.compiler.rootDir,
            {
              moduleMapLoaderPath: resolvePackageSourceFilePath(
                "src/internal/authored-module-map-loader.ts",
              ),
              sandboxAppRoot: preparedHost.appRoot,
            },
          ),
          log(message) {
            console.log(message);
          },
        }),
      );
    }
    await buildNitroOutput(nitro, profiler, "nitro");
    if (isVercelBuild) {
      await measureBuildPhase(profiler, "vercel.workflow-function.materialize", () =>
        materializeVercelWorkflowFunctionOutput(workspace.publication.output.stagedDir),
      );
    }
    if (servicePrefix !== undefined) {
      await measureBuildPhase(profiler, "vercel.functions.normalize", () =>
        normalizeEveVercelFunctionOutput(workspace.publication.output.stagedDir, {
          servicePrefix,
        }),
      );
    }
    const vercelServiceOutput = options.vercelServiceOutput;
    if (vercelServiceOutput !== undefined) {
      await measureBuildPhase(profiler, "vercel.service-crons.normalize", () =>
        normalizeVercelServiceCrons({
          publicRoutePrefix,
          serviceOutputDirectory: workspace.publication.output.stagedDir,
        }),
      );
      await measureBuildPhase(profiler, "vercel.host-middleware.copy", () =>
        copyHostMiddlewareFunctions({
          hostOutputDirectory: vercelServiceOutput.hostOutputDirectory,
          serviceOutputDirectory: workspace.publication.output.stagedDir,
        }),
      );
    }
    await measureBuildPhase(profiler, "agent-summary.emit", () =>
      emitVercelAgentSummary({
        manifest: preparedHost.compileResult.manifest,
        outputPath: workspace.publication.summary.stagedPath,
      }),
    );
    if (!isVercelBuild) {
      await measureBuildPhase(profiler, "compiler-artifacts.stage", () =>
        stageProductionCompilerArtifacts({
          compilerArtifactsRoot: workspace.compiler.artifactsDir,
          outputDir: workspace.publication.output.stagedDir,
        }),
      );
    }
  } finally {
    await measureBuildPhase(profiler, "nitro.close", () => nitro.close());
  }

  await measureBuildPhase(profiler, "output.publish", () =>
    publishCompletedApplicationBuild(workspace),
  );
  return workspace.publication.output.finalDir;
}

async function publishCompletedApplicationBuild(
  workspace: ApplicationBuildWorkspace,
): Promise<void> {
  await publishApplicationBuildArtifacts({
    appRoot: workspace.appRoot,
    finalOutputDir: workspace.publication.output.finalDir,
    finalSummaryPath: workspace.publication.summary.finalPath,
    scratchDir: workspace.rootDir,
    stagedOutputDir: workspace.publication.output.stagedDir,
    stagedSummaryPath: workspace.publication.summary.stagedPath,
  });
}
