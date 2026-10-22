import { join, relative, resolve } from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  createSandboxProviderResources,
  type SandboxPreparedArtifact,
  type SandboxProviderPrepareContext,
  type SandboxProviderResources,
  type SandboxProviderRuntime,
} from "#shared/sandbox-provider.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import {
  getResolvedRuntimeAgentNode,
  type ResolvedAgentGraphBundle,
  ROOT_RUNTIME_AGENT_NODE_ID,
} from "#runtime/graph.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import type { SandboxPreparedArtifactEntry } from "#shared/sandbox-prepared-artifacts.js";
import { writeSandboxPreparedArtifactsManifest } from "#runtime/sandbox/prepared-artifacts.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import { toErrorMessage } from "#shared/errors.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";

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
  readonly nodeId: string;
  readonly provider: SandboxProviderRuntime;
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
type SandboxProviderPrepareDispatch = (input: {
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
async function prewarmSandboxes(input: PrewarmSandboxesInput): Promise<void> {
  const targets = await collectPrewarmTargets(input);

  if (targets.length === 0) {
    return;
  }

  const preparedArtifactStore = input.preparedArtifactStore ?? diskPreparedArtifactStore;
  const dispatch =
    input.dispatch ??
    (async ({ context, provider }) => await provider.implementation.prepare(context));

  input.log?.(`eve: initializing ${formatSandboxTemplateCount(targets.length)}...`);

  const results = await Promise.allSettled(
    targets.map(async ({ context, label, nodeId, provider }) => {
      const logProviderProgress = (message: string) => {
        if (!shouldLogSandboxPrewarmProgress(message)) return;
        input.log?.(`eve: sandbox template "${label}" (${provider.providerName}): ${message}`);
      };
      try {
        const result = await dispatch({
          context: {
            ...context,
            log: input.log === undefined ? undefined : logProviderProgress,
          },
          provider,
        });
        return { nodeId, provider, result };
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
  // A failed provider must not release the preparation lock while others still write templates.
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const entries = results.flatMap((result) =>
    result.status === "fulfilled"
      ? [
          {
            artifact: result.value.result,
            nodeId: result.value.nodeId,
            providerName: result.value.provider.providerName,
          },
        ]
      : [],
  );
  await preparedArtifactStore.write({ compileDirectoryPath: input.compileDirectoryPath, entries });
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
      const agent = getResolvedRuntimeAgentNode(input.graph, nodeId).agent;
      const sandboxRoot = join(
        resolve(input.appRoot, relative(agent.metadata.appRoot, agent.metadata.agentRoot)),
        "sandbox",
      );
      const provider = getSandboxEnvironmentRuntime(definition.environment);
      const resources = await loadSandboxProviderResources({
        compileDirectoryPath: input.compileDirectoryPath,
        workspaceResourceRoot,
      });
      targets.push({
        context: {
          files: createSandboxProviderFiles(sandboxRoot),
          host: createSandboxProviderHost(input.appRoot),
          resources,
          sourceRevision: definition.revisionHash,
          storagePath: resolveSandboxCacheDirectory(input.appRoot),
        },
        label: formatLabel(nodeId),
        nodeId,
        provider,
      });
    }),
  );

  // Each graph node owns one manifest entry, so no deduplication is needed.
  return targets.sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Reads the node's compiled workspace resource root under `.eve/compile/`
 * into the resource trees handed to the provider. A root without content has
 * no resources.
 */
async function loadSandboxProviderResources(input: {
  readonly compileDirectoryPath: string;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): Promise<SandboxProviderResources> {
  const { contentHash, logicalPath } = input.workspaceResourceRoot;
  if (contentHash === undefined) return createSandboxProviderResources({});
  const path = `${input.compileDirectoryPath}/${logicalPath}`;
  return createSandboxProviderResources({
    key: contentHash,
    path,
    ...(await materializeWorkspaceDirectory(path)),
  });
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
  return !message.startsWith("checking ") && !message.startsWith("reusing ");
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
      "Vercel build containers cannot run local Docker containers. " +
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
  return providerName === "docker";
}
