import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { build as buildNitro, copyPublicAssets, prepare, prerender } from "nitro/builder";
import type { Nitro } from "nitro/types";

import { resolvePackageRoot, resolvePackageSourceFilePath } from "#internal/application/package.js";
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
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { normalizeEveVercelFunctionOutput } from "#internal/workflow-bundle/vercel-workflow-output.js";
import { createProductionApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { emitVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import { tryReadExtensionBuildConfig } from "#internal/nitro/host/build-extension.js";
import { copyHostMiddlewareFunctions } from "#internal/nitro/host/copy-host-middleware.js";
import { prepareProductionApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { runVercelBuildPrewarm } from "#internal/nitro/host/vercel-build-prewarm.js";
import type {
  ApplicationBuildOptions,
  NitroBuildSurface,
  PreparedApplicationHost,
} from "#internal/nitro/host/types.js";
import { findClosestVercelOutputDirectory } from "#shared/vercel-output-directory.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeEntrypoint(rootDir: string, entrypoint: unknown): string | null {
  if (typeof entrypoint !== "string" || entrypoint.trim().length === 0) {
    return null;
  }

  return resolve(rootDir, entrypoint);
}

function normalizeServiceRoot(rootDir: string, service: Record<string, unknown>): string | null {
  if (typeof service.root === "string" && service.root.trim().length > 0) {
    return resolve(rootDir, service.root);
  }

  return normalizeEntrypoint(rootDir, service.entrypoint);
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

function normalizeServiceCollection(
  value: unknown,
): readonly Record<string, unknown>[] | undefined {
  if (isRecord(value)) {
    return Object.values(value).filter(isRecord);
  }

  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  return undefined;
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
  appRoots: readonly string[];
  configRoot: string;
  config: unknown;
}): string | undefined {
  if (!isRecord(input.config)) {
    return undefined;
  }

  const services =
    normalizeServiceCollection(input.config.experimentalServices) ??
    normalizeServiceCollection(input.config.experimentalServicesV2) ??
    normalizeServiceCollection(input.config.services);

  if (services === undefined) {
    return undefined;
  }

  let hasHostService = false;
  let servicePrefix: string | undefined;

  for (const service of services) {
    if (service.framework !== "eve") {
      hasHostService = true;
      continue;
    }

    const eveEntrypoint = normalizeServiceRoot(input.configRoot, service);
    const routePrefix = normalizeServicePrefix(service);

    if (
      eveEntrypoint !== null &&
      input.appRoots.includes(eveEntrypoint) &&
      routePrefix.length > 0 &&
      routePrefix !== "/"
    ) {
      servicePrefix = routePrefix;
    }
  }

  return hasHostService ? servicePrefix : undefined;
}

async function resolveCoDeployedEveServicePrefixForVercelFunctionOutput(
  appRoot: string,
  agentRoot: string,
): Promise<string | undefined> {
  const appRoots = Array.from(new Set([resolve(appRoot), resolve(agentRoot)]));
  const outputDirectory = await findClosestVercelOutputDirectory(appRoot);

  if (outputDirectory !== undefined) {
    try {
      const config = JSON.parse(
        await readFile(join(outputDirectory, "config.json"), "utf8"),
      ) as unknown;
      const servicePrefix = resolveCoDeployedEveServicePrefix({
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
        const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
        const configRoot = configPath.endsWith("vercel.json")
          ? currentDir
          : await resolveVercelOutputConfigRoot(dirname(configPath));

        const servicePrefix = resolveCoDeployedEveServicePrefix({
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

async function resolveVercelOutputConfigRoot(outputDirectory: string): Promise<string> {
  const projectRoot = dirname(dirname(outputDirectory));

  try {
    const projectConfig = JSON.parse(
      await readFile(join(projectRoot, ".vercel", "project.json"), "utf8"),
    ) as unknown;

    if (
      isRecord(projectConfig) &&
      isRecord(projectConfig.settings) &&
      typeof projectConfig.settings.rootDirectory === "string" &&
      projectConfig.settings.rootDirectory.trim().length > 0
    ) {
      return resolve(projectRoot, projectConfig.settings.rootDirectory);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return projectRoot;
}

async function emitVercelWorkflowFunctions(input: {
  agentName: string;
  appRoot: string;
  compiledArtifactsBootstrapPath: string;
  flowNitroOutputDir: string;
  outputDir: string;
  workflowBuildDir: string;
}): Promise<void> {
  const builder = new WorkflowBundleBuilder({
    agentName: input.agentName,
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

async function buildVercelNitroSurface(
  preparedHost: PreparedApplicationHost,
  workspace: ApplicationBuildWorkspace,
  surface: Exclude<NitroBuildSurface, "all">,
  profiler: ApplicationBuildProfiler | undefined,
): Promise<string> {
  const phasePrefix = `nitro.${surface}`;
  const nitro = await measureBuildPhase(profiler, `${phasePrefix}.create`, () =>
    createProductionApplicationNitro(preparedHost, {
      buildDir: join(workspace.nitro.buildDir, surface),
      outputDir: join(workspace.nitro.surfaceOutputDir, surface),
      surface,
    }),
  );

  try {
    return await buildNitroOutput(nitro, profiler, phasePrefix);
  } finally {
    await measureBuildPhase(profiler, `${phasePrefix}.close`, () => nitro.close());
  }
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
    assertProfileOutputOutsideBuildOutput(profileOutputPath, workspace.publication.output.finalDir);
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
    const timing = profiler.finish();
    const output = await measureApplicationBuildOutput(outputDirectory);
    await writeApplicationBuildProfile(
      profileOutputPath,
      createApplicationBuildProfile({
        output,
        target: process.env.VERCEL ? "vercel" : "local",
        timing,
      }),
    );
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

  if (!process.env.VERCEL) {
    const nitro = await measureBuildPhase(profiler, "nitro.all.create", () =>
      createProductionApplicationNitro(preparedHost, {
        buildDir: workspace.nitro.buildDir,
        outputDir: workspace.publication.output.stagedDir,
        surface: "all",
      }),
    );

    try {
      await buildNitroOutput(nitro, profiler, "nitro.all");
      await measureBuildPhase(profiler, "agent-summary.emit", () =>
        emitVercelAgentSummary({
          manifest: preparedHost.compileResult.manifest,
          outputPath: workspace.publication.summary.stagedPath,
        }),
      );
      await measureBuildPhase(profiler, "compiler-artifacts.stage", () =>
        stageProductionCompilerArtifacts({
          compilerArtifactsRoot: workspace.compiler.artifactsDir,
          outputDir: workspace.publication.output.stagedDir,
        }),
      );
    } finally {
      await measureBuildPhase(profiler, "nitro.all.close", () => nitro.close());
    }

    await measureBuildPhase(profiler, "output.publish", () =>
      publishCompletedApplicationBuild(workspace),
    );
    return workspace.publication.output.finalDir;
  }

  const servicePrefix = await measureBuildPhase(profiler, "vercel.service-prefix.resolve", () =>
    resolveCoDeployedEveServicePrefixForVercelFunctionOutput(
      preparedHost.appRoot,
      preparedHost.compileResult.project.agentRoot,
    ),
  );
  const nitro = await measureBuildPhase(profiler, "nitro.app.create", () =>
    createProductionApplicationNitro(preparedHost, {
      buildDir: join(workspace.nitro.buildDir, "app"),
      outputDir: workspace.publication.output.stagedDir,
      surface: "app",
    }),
  );

  try {
    await buildNitroOutput(nitro, profiler, "nitro.app");
    // Run sandbox prewarm before emitting the workflow functions so a
    // prewarm failure aborts the build before we spend time bundling
    // function output that we would never deploy.
    if (!options.skipVercelSandboxPrewarm) {
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
    const flowNitroOutputDir = await buildVercelNitroSurface(
      preparedHost,
      workspace,
      "flow",
      profiler,
    );
    await measureBuildPhase(profiler, "workflow.emit", () =>
      emitVercelWorkflowFunctions({
        agentName: preparedHost.compileResult.manifest.config.name,
        appRoot: preparedHost.appRoot,
        compiledArtifactsBootstrapPath: preparedHost.compiledArtifacts.bootstrapPath,
        flowNitroOutputDir,
        outputDir: workspace.publication.output.stagedDir,
        workflowBuildDir: workspace.workflow.buildDir,
      }),
    );
    if (servicePrefix !== undefined) {
      await measureBuildPhase(profiler, "vercel.functions.normalize", () =>
        normalizeEveVercelFunctionOutput(workspace.publication.output.stagedDir, {
          servicePrefix,
        }),
      );
    }
    const vercelServiceOutput = options.vercelServiceOutput;
    if (vercelServiceOutput !== undefined) {
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
  } finally {
    await measureBuildPhase(profiler, "nitro.app.close", () => nitro.close());
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
