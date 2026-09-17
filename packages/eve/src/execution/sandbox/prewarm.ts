import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  createSandboxProviderResources,
  type SandboxPreparedArtifact,
  type SandboxProviderPrepareContext,
  type SandboxProviderRuntime,
} from "#shared/sandbox-provider.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { type ResolvedAgentGraphBundle, ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { createRuntimeSandboxTemplateKey } from "#runtime/sandbox/keys.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import type { SandboxPreparedArtifactEntry } from "#shared/sandbox-prepared-artifacts.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import { writeSandboxPreparedArtifactsManifest } from "#runtime/sandbox/prepared-artifacts.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  getSandboxEnvironmentConfigurationHash,
  getSandboxEnvironmentRuntime,
} from "#shared/sandbox-environment.js";
import { withSandboxTemplatePrewarmLock } from "./template-prewarm-lock.js";

export interface SandboxPreparedArtifactStore {
  write(input: {
    readonly compileDirectoryPath: string;
    readonly entries: readonly SandboxPreparedArtifactEntry[];
  }): Promise<void>;
}

const diskPreparedArtifactStore: SandboxPreparedArtifactStore = {
  async write(input) {
    await writeSandboxPreparedArtifactsManifest(input);
  },
};

interface PrewarmTarget {
  readonly context: SandboxProviderPrepareContext;
  readonly label: string;
  readonly provider: SandboxProviderRuntime;
  readonly templateName: string;
}

interface NodeSandbox extends RuntimeRegisteredSandbox {
  readonly definition: Extract<
    RuntimeRegisteredSandbox["definition"],
    { readonly kind: "independent" }
  >;
  readonly nodeId: string;
}

/**
 * Optional dispatch override that intercepts every provider `prepare()`
 * call. Production code never supplies this; the orchestrator dispatches
 * directly to the provider. Tests inject a recorder to verify which
 * templates the orchestrator emits and what preparation calls flow through
 * them.
 */
export type SandboxProviderPrepareDispatch = (input: {
  readonly context: SandboxProviderPrepareContext;
  readonly provider: SandboxProviderRuntime;
}) => Promise<SandboxPreparedArtifact>;

interface PrewarmSandboxesInput {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxProviderPrepareDispatch;
  readonly preparedArtifactStore?: SandboxPreparedArtifactStore;
}

/**
 * Prepares every provider sandbox template required by one compiled
 * runtime graph.
 *
 * Iterates every registered sandbox and invokes `provider.prepare(...)`
 * for each provider template.
 */
export async function prewarmSandboxes(input: PrewarmSandboxesInput): Promise<void> {
  const targets = await collectPrewarmTargets(input);

  if (targets.length === 0) {
    return;
  }

  const preparedArtifactStore = input.preparedArtifactStore ?? diskPreparedArtifactStore;
  const dispatch =
    input.dispatch ??
    (async ({ context, provider }) => await provider.implementation.prepare(context));

  input.log?.(`eve: initializing ${formatSandboxTemplateCount(targets.length)}...`);

  const results = await Promise.all(
    targets.map(async ({ context, label, provider, templateName }) => {
      const logProviderProgress = (message: string) => {
        if (!shouldLogSandboxPrewarmProgress(message)) return;
        input.log?.(`eve: sandbox template "${label}" (${provider.providerName}): ${message}`);
      };
      try {
        const result = await withSandboxTemplatePrewarmLock(
          {
            appRoot: input.appRoot,
            providerName: provider.providerName,
            templateKey: templateName,
          },
          async () =>
            await dispatch({
              context: {
                ...context,
                log: input.log === undefined ? undefined : logProviderProgress,
              },
              provider,
            }),
        );
        return { provider, result, templateName };
      } catch (error) {
        const prewarmError = formatPrewarmFailureForEnvironment({
          providerName: provider.providerName,
          error,
        });
        input.log?.(
          `eve: failed to initialize sandbox template "${label}" on provider "${provider.providerName}": ${toErrorMessage(prewarmError)}`,
        );
        throw prewarmError;
      }
    }),
  );
  await preparedArtifactStore.write({
    compileDirectoryPath: input.compileDirectoryPath,
    entries: results.map(({ provider, result, templateName }) => ({
      artifact: result,
      providerName: provider.providerName,
      templateName,
    })),
  });
  input.log?.(`eve: initialized ${formatSandboxTemplateCount(targets.length)}.`);
}

/**
 * Loads the compiled runtime graph for one authored app root and
 * prepares every provider sandbox template required by that graph.
 *
 * Hydrates the module map directly from authored source so callers
 * don't need a pre-existing `module-map.mjs` import in Node's cache.
 * Shared entrypoint for `eve dev` startup, the dev watcher, and the
 * Vercel build hook.
 */
export async function prewarmAppSandboxes(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  readonly loadAgentGraph?: (
    input: Readonly<{
      compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
    }>,
  ) => Promise<ResolvedAgentGraphBundle>;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxProviderPrepareDispatch;
  readonly preparedArtifactStore?: SandboxPreparedArtifactStore;
}): Promise<void> {
  const compiledArtifactsSource =
    input.compiledArtifactsSource ??
    createAuthoredSourceRuntimeCompiledArtifactsSource(input.appRoot);
  if (compiledArtifactsSource.kind !== "disk") {
    throw new Error("prewarmAppSandboxes requires disk-backed compiled artifacts.");
  }
  const graph = await (input.loadAgentGraph ?? loadGraphFromArtifacts)({
    compiledArtifactsSource,
  });

  await prewarmSandboxes({
    appRoot: getRuntimeCompiledArtifactsSandboxAppRoot(compiledArtifactsSource) ?? input.appRoot,
    compileDirectoryPath: resolveRuntimeCompilerArtifactPaths(compiledArtifactsSource.appRoot)
      .compileDirectoryPath,
    compiledArtifactsSource,
    dispatch: input.dispatch,
    graph,
    log: input.log,
    preparedArtifactStore: input.preparedArtifactStore,
  });
}

async function collectPrewarmTargets(input: {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
}): Promise<readonly PrewarmTarget[]> {
  const targets: PrewarmTarget[] = [];

  await Promise.all(
    collectNodeSandboxes(input.graph).map(async ({ definition, nodeId, workspaceResourceRoot }) => {
      const resolvedAgentRoot = await resolveAuthoredAgentRoot(input.appRoot, nodeId);
      const sandboxRoot = join(resolvedAgentRoot, "sandbox");
      const templatePlan = createRuntimeSandboxTemplatePlan({
        definition,
        workspaceResourceRoot,
      });
      const provider = getSandboxEnvironmentRuntime(definition.environment);
      const templateKey = await createRuntimeSandboxTemplateKey({
        providerName: definition.environment.provider,
        compiledArtifactsSource: input.compiledArtifactsSource,
        configurationHash: getSandboxEnvironmentConfigurationHash(definition.environment),
        nodeId,
        sourceId: definition.sourceId,
        templatePlan,
      });

      const seedFiles = await loadResourceRootSeedFiles({
        compileDirectoryPath: input.compileDirectoryPath,
        workspaceResourceRoot,
      });
      targets.push({
        context: {
          files: createSandboxProviderFiles(sandboxRoot),
          host: createSandboxProviderHost(input.appRoot),
          resources: createSandboxProviderResources({
            resourcesKey: workspaceResourceRoot.contentHash,
            resourcesPath:
              workspaceResourceRoot.contentHash === undefined
                ? undefined
                : `${input.compileDirectoryPath}/${workspaceResourceRoot.logicalPath}`,
            seedFiles,
          }),
          storagePath: resolveSandboxCacheDirectory(input.appRoot),
        },
        label: formatLabel(nodeId),
        provider,
        templateName: templateKey,
      });
    }),
  );

  // Template keys factor in nodeId (see runtime/sandbox/keys.ts), so each
  // node already produces a distinct templateKey; no dedup is needed.
  return targets.sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Resolves the per-node compiled workspace resource root to an absolute
 * disk path under `.eve/compile/` and materializes its contents into the
 * `{path, content}` shape consumed by sandbox providers.
 *
 * Returns an empty array when the resource root descriptor advertises no
 * root entries (the materializer would emit no files anyway).
 */
async function loadResourceRootSeedFiles(input: {
  readonly compileDirectoryPath: string;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): Promise<readonly { readonly content: Uint8Array; readonly path: string }[]> {
  if (
    input.workspaceResourceRoot.contentHash === undefined &&
    input.workspaceResourceRoot.rootEntries.length === 0
  ) {
    return [];
  }
  const materialized = await materializeWorkspaceDirectory(
    `${input.compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}`,
  );
  return materialized.map((file) => ({ content: file.content, path: file.path }));
}

async function loadGraphFromArtifacts(input: {
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
}): Promise<ResolvedAgentGraphBundle> {
  const [manifest, moduleMap] = await Promise.all([
    loadCompiledManifest({
      compiledArtifactsSource: input.compiledArtifactsSource,
    }),
    loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource: input.compiledArtifactsSource,
    }),
  ]);

  return await resolveRuntimeAgentGraph({
    manifest,
    moduleMap,
  });
}

async function resolveAuthoredAgentRoot(appRoot: string, nodeId: string): Promise<string> {
  const path =
    nodeId === ROOT_RUNTIME_AGENT_NODE_ID ? join(appRoot, "agent") : join(appRoot, "agent", nodeId);
  try {
    return (await stat(path)).isDirectory() ? path : dirname(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return path;
    throw error;
  }
}

function collectNodeSandboxes(graph: ResolvedAgentGraphBundle): readonly NodeSandbox[] {
  return [...graph.nodesByNodeId.entries()].flatMap(([nodeId, node]) => {
    const registered = node.sandboxRegistry.sandbox;
    if (registered.definition.kind === "parent") return [];
    return [
      {
        ...registered,
        definition: registered.definition,
        nodeId,
      },
    ];
  });
}

function formatLabel(nodeId: string): string {
  return nodeId === ROOT_RUNTIME_AGENT_NODE_ID ? "root" : nodeId;
}

function formatSandboxTemplateCount(count: number): string {
  return `${count} sandbox ${count === 1 ? "template" : "templates"}`;
}

function shouldLogSandboxPrewarmProgress(message: string): boolean {
  return (
    !message.startsWith("checking ") &&
    !message.startsWith("reusing ") &&
    message !== "loading microsandbox runtime" &&
    message !== "microsandbox runtime ready"
  );
}

function formatPrewarmFailureForEnvironment(input: {
  readonly providerName: string;
  readonly error: unknown;
}): unknown {
  if (!isVercelEnvironment() || !isLocalSandboxProvider(input.providerName)) {
    return input.error;
  }

  return new Error(
    `The ${input.providerName} sandbox provider is not available when deploying on Vercel. ` +
      "Vercel build containers cannot run local Docker containers or microsandbox VMs. " +
      "Use DefaultSandbox.environment() so eve selects Vercel Sandbox on Vercel, or configure " +
      "VercelSandbox.environment() explicitly. " +
      `Original ${input.providerName} error: ${toErrorMessage(input.error)}`,
    { cause: input.error },
  );
}

function isVercelEnvironment(): boolean {
  return Boolean(process.env.VERCEL?.trim());
}

function isLocalSandboxProvider(providerName: string): boolean {
  return providerName === "docker" || providerName === "microsandbox";
}
