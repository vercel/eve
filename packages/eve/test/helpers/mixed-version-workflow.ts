import { mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Runtime } from "#channel/types.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import type { ScenarioApp, ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";
import { materializeScenarioApp } from "#internal/testing/scenario-app.js";
import {
  deriveEveWorkflowQueuePrefix,
  installEveWorkflowQueueNamespace,
} from "#internal/workflow/queue-namespace.js";
import {
  createRuntimeSession,
  getActiveRuntimeSession,
  type RuntimeSession,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";
import { createWorld, type LocalWorld } from "#compiled/@workflow/world-local/index.js";
import type { World } from "#compiled/@workflow/world/index.js";

const HISTORICAL_EVE_VERSION = "0.30.8";
// The vendored World runtime is stubbed in published eve packages, so its
// protocol version cannot be imported. These values are pinned by the cohort
// scenario and must move only when that package's Workflow runtime moves.
const HISTORICAL_WORKFLOW_SPEC_VERSION = 5;
const CANDIDATE_WORKFLOW_SPEC_VERSION = 6;

interface WorkflowBundleBuilderConstructor {
  new (options: {
    readonly agentName: string;
    readonly appRoot: string;
    readonly compiledArtifactsBootstrapPath: string;
    readonly outDir: string;
    readonly rootDir: string;
    readonly watch: boolean;
  }): {
    build(): Promise<void>;
  };
}

interface VersionCompilerModule {
  compileAgent(input: { readonly startPath: string }): Promise<VersionCompileResult>;
}

interface VersionCompileResult {
  readonly manifest: unknown;
  readonly metadata: unknown;
  readonly paths: unknown;
}

interface VersionCompiledArtifactsModule {
  writeCompiledArtifactsFiles(input: {
    readonly compileResult: VersionCompileResult;
    readonly defaultWorkflowWorld: "local";
    readonly outDir: string;
  }): Promise<{ readonly bootstrapPath: string }>;
}

interface WorkflowDiscoveredEntries {
  readonly discoveredSerdeFiles: string[];
  readonly discoveredSteps: string[];
  readonly discoveredWorkflows: string[];
}

interface VersionWorkflowBuilderSupportModule {
  bundleWorkflowStepRegistrations(input: {
    readonly builtinsPath: string;
    readonly discoveredEntries: WorkflowDiscoveredEntries;
    readonly outfile: string;
    readonly projectRoot: string;
    readonly workingDir: string;
  }): Promise<void>;
  collectWorkflowInputFiles(root: string): Promise<string[]>;
}

interface VersionWorkflowBuildersModule {
  detectWorkflowPatterns(source: string): {
    readonly hasSerde: boolean;
    readonly hasUseStep: boolean;
    readonly hasUseWorkflow: boolean;
  };
}

interface VersionWorkflowRuntimeModule {
  createWorkflowRuntime(config: { readonly compiledArtifactsSource: unknown }): Runtime;
}

interface VersionCompiledArtifactsSourceModule {
  createBundledRuntimeCompiledArtifactsSource(): unknown;
}

interface VersionWorkflowCoreRuntimeModule {
  setWorld(world: unknown): void;
}

export interface MixedVersionDeployment {
  readonly deploymentId: string;
  readonly eveVersion: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly packageRoot: string;
  readonly specVersion: number;
  activateArtifacts(): Promise<void>;
  createRuntime(): Promise<Runtime>;
}

export interface WorkflowHandlerDelivery {
  readonly deploymentId: string;
  readonly runId: string;
}

export interface PromotableWorkflowWorld {
  readonly deliveries: readonly WorkflowHandlerDelivery[];
  readonly world: World;
  close(): Promise<void>;
  promote(deploymentId: string): void;
  runInDeployment<T>(deploymentId: string, callback: () => Promise<T>): Promise<T>;
  start(): Promise<void>;
}

/** Materializes one descriptor against either the candidate or the published cohort. */
export async function materializeMixedVersionWorkflowApp(input: {
  readonly descriptor: ScenarioAppDescriptor;
  readonly eveVersion: "current" | typeof HISTORICAL_EVE_VERSION;
}): Promise<ScenarioApp> {
  const app = await materializeScenarioApp({
    ...input.descriptor,
    installDependencies: true,
  });
  if (input.eveVersion === "current") return app;

  const appEvePackage = join(app.appRoot, "node_modules", "eve");
  const historicalPackage = await realpath(
    join(resolvePackageRoot(), "node_modules", "historical-eve-0-30-8"),
  );
  await rm(appEvePackage, { force: true, recursive: true });
  await symlink(historicalPackage, appEvePackage, "dir");
  return app;
}

/** Builds and loads a handler using only the eve installation under that app. */
export async function buildMixedVersionWorkflowDeployment(input: {
  readonly agentName: string;
  readonly appRoot: string;
  readonly deploymentId: string;
  readonly eveVersion: "current" | typeof HISTORICAL_EVE_VERSION;
}): Promise<MixedVersionDeployment> {
  const packageRoot = await realpath(join(input.appRoot, "node_modules", "eve"));
  const outputRoot = join(input.appRoot, ".eve", "mixed-version", input.deploymentId);
  const bootstrapPath = join(input.appRoot, ".eve", "mixed-version-bootstrap", input.deploymentId);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(bootstrapPath, { recursive: true });

  const [builderModule, compilerModule, compiledArtifactsModule, builderSupport, workflowBuilders] =
    (await Promise.all([
      importPackageModule(packageRoot, "internal/workflow-bundle/builder.js"),
      importPackageModule(packageRoot, "compiler/compile-agent.js"),
      importPackageModule(packageRoot, "internal/application/compiled-artifacts.js"),
      importPackageModule(packageRoot, "internal/workflow-bundle/builder-support.js"),
      importPackageModule(packageRoot, "internal/workflow-bundle/workflow-builders.js"),
    ])) as [
      { WorkflowBundleBuilder: WorkflowBundleBuilderConstructor },
      VersionCompilerModule,
      VersionCompiledArtifactsModule,
      VersionWorkflowBuilderSupportModule,
      VersionWorkflowBuildersModule,
    ];
  const compileResult = await compilerModule.compileAgent({ startPath: input.appRoot });
  const generatedArtifacts = await compiledArtifactsModule.writeCompiledArtifactsFiles({
    compileResult,
    defaultWorkflowWorld: "local",
    outDir: bootstrapPath,
  });
  const builder = new builderModule.WorkflowBundleBuilder({
    agentName: input.agentName,
    appRoot: input.appRoot,
    compiledArtifactsBootstrapPath: generatedArtifacts.bootstrapPath,
    outDir: outputRoot,
    rootDir: packageRoot,
    watch: false,
  });
  await builder.build();
  const discoveredEntries = await discoverWorkflowEntries({
    builderSupport,
    packageRoot,
    workflowBuilders,
  });
  await builderSupport.bundleWorkflowStepRegistrations({
    builtinsPath: join(packageRoot, "dist", "src", "internal", "workflow", "builtins.js"),
    discoveredEntries,
    outfile: join(outputRoot, "steps.mjs"),
    projectRoot: input.appRoot,
    workingDir: packageRoot,
  });

  const handlerModule = (await import(pathToFileURL(join(outputRoot, "workflows.mjs")).href)) as {
    POST: (request: Request) => Promise<Response>;
  };
  const bootstrapModule = (await import(pathToFileURL(generatedArtifacts.bootstrapPath).href)) as {
    installCompiledArtifactsBootstrap: () => void;
  };
  return {
    deploymentId: input.deploymentId,
    eveVersion: input.eveVersion,
    handler: handlerModule.POST,
    packageRoot,
    specVersion:
      input.eveVersion === HISTORICAL_EVE_VERSION
        ? HISTORICAL_WORKFLOW_SPEC_VERSION
        : CANDIDATE_WORKFLOW_SPEC_VERSION,
    async activateArtifacts() {
      bootstrapModule.installCompiledArtifactsBootstrap();
    },
    async createRuntime() {
      const [runtimeModule, sourceModule] = (await Promise.all([
        importPackageModule(packageRoot, "execution/workflow-runtime.js"),
        importPackageModule(packageRoot, "runtime/compiled-artifacts-source.js"),
      ])) as [VersionWorkflowRuntimeModule, VersionCompiledArtifactsSourceModule];
      return runtimeModule.createWorkflowRuntime({
        compiledArtifactsSource: sourceModule.createBundledRuntimeCompiledArtifactsSource(),
      });
    },
  };
}

/**
 * Hosts immutable version handlers on one local World and dispatches every
 * delivery from the run's persisted deployment identity.
 */
export async function createPromotableWorkflowWorld(input: {
  readonly agentName: string;
  readonly dataDir: string;
  readonly deployments: readonly MixedVersionDeployment[];
  readonly initialDeploymentId: string;
}): Promise<PromotableWorkflowWorld> {
  const localWorld = createWorld({ dataDir: input.dataDir, recoverActiveRuns: false });
  const deployments = new Map(input.deployments.map((entry) => [entry.deploymentId, entry]));
  const runtimeSessions = new Map(
    input.deployments.map((deployment) => [
      deployment.deploymentId,
      createRuntimeSession(`mixed-version:${deployment.deploymentId}`),
    ]),
  );
  const deploymentByRuntimeSession = new WeakMap<RuntimeSession, MixedVersionDeployment>();
  for (const deployment of input.deployments) {
    deploymentByRuntimeSession.set(getRuntimeSession(deployment.deploymentId), deployment);
  }
  const deliveries: WorkflowHandlerDelivery[] = [];
  let promotedDeploymentId = input.initialDeploymentId;
  installEveWorkflowQueueNamespace(input.agentName);

  const world = new Proxy(localWorld, {
    get(target, property, receiver) {
      if (property === "specVersion") {
        return (
          deploymentByRuntimeSession.get(getActiveRuntimeSession())?.specVersion ??
          getDeployment(promotedDeploymentId).specVersion
        );
      }
      if (property === "getDeploymentId") {
        return async () =>
          deploymentByRuntimeSession.get(getActiveRuntimeSession())?.deploymentId ??
          getDeployment(promotedDeploymentId).deploymentId;
      }
      if (property === "resolveLatestDeploymentId") {
        return async () => getDeployment(promotedDeploymentId).deploymentId;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as World;

  for (const deployment of input.deployments) {
    const runtimeModule = (await importPackageModule(
      deployment.packageRoot,
      "compiled/@workflow/core/runtime.js",
    )) as VersionWorkflowCoreRuntimeModule;
    runtimeModule.setWorld(world);
  }

  localWorld.registerHandler(deriveEveWorkflowQueuePrefix(input.agentName), async (request) => {
    const payload = (await request.clone().json()) as unknown;
    const runId = readDeliveryRunId(payload);
    const deploymentId = await resolveDeliveryDeploymentId(
      localWorld,
      payload,
      runId,
      promotedDeploymentId,
      request.headers.get("x-vqs-queue-name")?.endsWith("_health_check") === true,
    );
    const deployment = getDeployment(deploymentId);
    deliveries.push({ deploymentId, runId });
    return await withRuntimeSession(getRuntimeSession(deploymentId), async () => {
      await deployment.activateArtifacts();
      return await deployment.handler(request);
    });
  });

  function getDeployment(deploymentId: string): MixedVersionDeployment {
    const deployment = deployments.get(deploymentId);
    if (deployment === undefined) {
      throw new Error(`No mixed-version Workflow handler is registered for "${deploymentId}".`);
    }
    return deployment;
  }

  function getRuntimeSession(deploymentId: string): RuntimeSession {
    const session = runtimeSessions.get(deploymentId);
    if (session === undefined) {
      throw new Error(`No mixed-version runtime session is registered for "${deploymentId}".`);
    }
    return session;
  }

  return {
    deliveries,
    world,
    async close() {
      for (const deployment of input.deployments) {
        const runtimeModule = (await importPackageModule(
          deployment.packageRoot,
          "compiled/@workflow/core/runtime.js",
        )) as VersionWorkflowCoreRuntimeModule;
        runtimeModule.setWorld(undefined);
      }
      await localWorld.close?.();
    },
    promote(deploymentId) {
      getDeployment(deploymentId);
      promotedDeploymentId = deploymentId;
    },
    async runInDeployment(deploymentId, callback) {
      const deployment = getDeployment(deploymentId);
      return await withRuntimeSession(getRuntimeSession(deploymentId), async () => {
        await deployment.activateArtifacts();
        return await callback();
      });
    },
    async start() {
      await localWorld.start?.();
    },
  };
}

async function importPackageModule(packageRoot: string, relativePath: string): Promise<unknown> {
  return await import(pathToFileURL(join(packageRoot, "dist", "src", relativePath)).href);
}

async function discoverWorkflowEntries(input: {
  readonly builderSupport: VersionWorkflowBuilderSupportModule;
  readonly packageRoot: string;
  readonly workflowBuilders: VersionWorkflowBuildersModule;
}): Promise<WorkflowDiscoveredEntries> {
  const entries: WorkflowDiscoveredEntries = {
    discoveredSerdeFiles: [],
    discoveredSteps: [],
    discoveredWorkflows: [],
  };
  const files = await input.builderSupport.collectWorkflowInputFiles(
    join(input.packageRoot, "dist", "src", "execution"),
  );
  for (const filePath of files) {
    const patterns = input.workflowBuilders.detectWorkflowPatterns(
      await readFile(filePath, "utf8"),
    );
    if (patterns.hasSerde) entries.discoveredSerdeFiles.push(filePath);
    if (patterns.hasUseStep) entries.discoveredSteps.push(filePath);
    if (patterns.hasUseWorkflow) entries.discoveredWorkflows.push(filePath);
  }
  return entries;
}

function readDeliveryRunId(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("Workflow delivery payload is not an object.");
  const runId =
    typeof payload.runId === "string"
      ? payload.runId
      : typeof payload.workflowRunId === "string"
        ? payload.workflowRunId
        : undefined;
  if (runId === undefined) throw new Error("Workflow delivery payload does not identify its run.");
  return runId;
}

async function resolveDeliveryDeploymentId(
  world: LocalWorld,
  payload: unknown,
  runId: string,
  fallbackDeploymentId: string,
  isHealthCheck: boolean,
): Promise<string> {
  if (isRecord(payload) && isRecord(payload.runInput)) {
    const deploymentId = payload.runInput.deploymentId;
    if (typeof deploymentId === "string") return deploymentId;
  }
  try {
    return (await world.runs.get(runId, { resolveData: "none" })).deploymentId;
  } catch (error) {
    if (isHealthCheck) {
      // Workflow's queue health check intentionally uses a synthetic run id.
      return fallbackDeploymentId;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
