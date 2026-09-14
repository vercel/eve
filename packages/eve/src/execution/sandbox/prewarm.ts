import { join } from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  createSandboxProviderResources,
  type SandboxPreparedArtifact,
  type SandboxProviderPrepareContext,
  type SandboxProviderRuntime,
} from "#shared/sandbox-provider.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { type ResolvedAgentGraphBundle, ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { loadCompileMetadata } from "#runtime/loaders/compile-metadata.js";
import {
  updateBundledSandboxPreparedArtifacts,
  withBundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { resolveSandboxDockerfile } from "#execution/sandbox/dockerfile.js";
import { createRuntimeSandboxTemplateKey } from "#runtime/sandbox/keys.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import type { SandboxPreparedArtifactEntry } from "#shared/sandbox-prepared-artifacts.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import {
  loadSandboxPreparedArtifactsManifest,
  writeSandboxPreparedArtifactsManifest,
} from "#runtime/sandbox/prepared-artifacts.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  getSandboxEnvironmentConfigurationHash,
  getSandboxEnvironmentPreparation,
  getSandboxEnvironmentRuntime,
} from "#shared/sandbox-environment.js";
import { withSandboxTemplatePrewarmLock } from "./template-prewarm-lock.js";

export interface SandboxPreparedArtifactStore {
  has(
    source: RuntimeCompiledArtifactsSource,
    entries: readonly { readonly providerName: string; readonly templateName: string }[],
  ): Promise<boolean>;
  write(input: {
    readonly compileDirectoryPath: string;
    readonly entries: readonly SandboxPreparedArtifactEntry[];
  }): Promise<void>;
}

const diskPreparedArtifactStore: SandboxPreparedArtifactStore = {
  async has(source, entries) {
    const manifest = await loadSandboxPreparedArtifactsManifest(source);
    if (manifest === null) return false;
    const keys = new Set(
      manifest.entries.map((entry) => `${entry.providerName}\0${entry.templateName}`),
    );
    return entries.every((entry) => keys.has(`${entry.providerName}\0${entry.templateName}`));
  },
  async write(input) {
    await writeSandboxPreparedArtifactsManifest(input);
  },
};

interface PrewarmTarget {
  readonly context: SandboxProviderPrepareContext;
  readonly label: string;
  readonly provider: SandboxProviderRuntime;
  readonly signature: string;
}

interface NodeSandbox extends RuntimeRegisteredSandbox {
  readonly definition: Extract<
    RuntimeRegisteredSandbox["definition"],
    { readonly kind: "independent" }
  >;
  readonly nodeId: string;
}

/**
 * Optional dispatch override that intercepts every `backend.prewarm`
 * call. Production code never supplies this; the orchestrator dispatches
 * directly to the backend. Tests inject a recorder to verify which
 * templates the orchestrator emits and what preparation calls flow through
 * them.
 */
export type SandboxProviderPrepareDispatch = (input: {
  readonly context: SandboxProviderPrepareContext;
  readonly provider: SandboxProviderRuntime;
}) => Promise<{
  readonly artifact: SandboxPreparedArtifact;
  readonly reused: boolean;
}>;

interface PrewarmSandboxesInput {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly force?: boolean;
  readonly graph: ResolvedAgentGraphBundle;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxProviderPrepareDispatch;
  readonly onPrewarmSignature?: (signature: string) => void;
  readonly preparedArtifactStore?: SandboxPreparedArtifactStore;
  readonly shouldPrewarmSignature?: (signature: string) => boolean;
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

  const signature = createPrewarmSignature(targets);
  const preparedArtifactStore = input.preparedArtifactStore ?? diskPreparedArtifactStore;
  if (
    input.shouldPrewarmSignature?.(signature) === false &&
    (await preparedArtifactStore.has(
      input.compiledArtifactsSource,
      targets.map((target) => ({
        providerName: target.provider.providerName,
        templateName: target.context.templateName,
      })),
    ))
  ) {
    return;
  }

  const dispatch =
    input.dispatch ??
    (async ({ context, provider }) => await provider.implementation.prepare(context));

  input.log?.(`eve: initializing ${formatSandboxTemplateCount(targets.length)}...`);

  const results = await Promise.all(
    targets.map(async ({ context, label, provider }) => {
      const logProviderProgress = (message: string) => {
        if (!shouldLogSandboxPrewarmProgress(message)) return;
        input.log?.(`eve: sandbox template "${label}" (${provider.providerName}): ${message}`);
      };
      try {
        const result = await withSandboxTemplatePrewarmLock(
          {
            appRoot: context.appRoot,
            providerName: provider.providerName,
            templateKey: context.templateName,
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
        return { context, provider, result };
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
    entries: results.map(({ context, provider, result }) => ({
      artifact: result.artifact,
      providerName: provider.providerName,
      templateName: context.templateName,
    })),
  });
  const reusedCount = results.filter(({ result }) => result.reused).length;
  input.log?.(
    `eve: initialized ${formatSandboxTemplateCount(targets.length)} (${reusedCount} reused, ${
      targets.length - reusedCount
    } built).`,
  );
  input.onPrewarmSignature?.(signature);
}

/**
 * Loads the compiled runtime graph for one authored app root and
 * prepares every provider.s sandbox templates required by that graph.
 *
 * Hydrates the module map directly from authored source so callers
 * don't need a pre-existing `module-map.mjs` import in Node's cache.
 * Shared entrypoint for `eve dev` startup, the dev watcher, and the
 * Vercel build hook.
 */
export async function prewarmAppSandboxes(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  readonly force?: boolean;
  readonly loadAgentGraph?: (
    input: Readonly<{
      compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
    }>,
  ) => Promise<ResolvedAgentGraphBundle>;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxProviderPrepareDispatch;
  readonly onPrewarmSignature?: (signature: string) => void;
  readonly preparedArtifactStore?: SandboxPreparedArtifactStore;
  readonly shouldPrewarmSignature?: (signature: string) => boolean;
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
    force: input.force,
    graph,
    log: input.log,
    onPrewarmSignature: input.onPrewarmSignature,
    preparedArtifactStore: input.preparedArtifactStore,
    shouldPrewarmSignature: input.shouldPrewarmSignature,
  });
}

/**
 * Loads one built app's bundled compiled artifacts and prewarms the sandbox
 * templates that its production Nitro runtime will request.
 */
export async function prewarmBuiltAppSandboxes(input: {
  readonly appRoot: string;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxProviderPrepareDispatch;
}): Promise<void> {
  const builtArtifactsRoot = join(input.appRoot, ".output");
  const builtArtifactsSource = createDiskRuntimeCompiledArtifactsSource(builtArtifactsRoot, {
    moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"),
    sandboxAppRoot: input.appRoot,
  });
  const [metadata, manifest, moduleMap] = await Promise.all([
    loadCompileMetadata({
      compiledArtifactsSource: builtArtifactsSource,
    }),
    loadCompiledManifest({
      compiledArtifactsSource: builtArtifactsSource,
    }),
    loadCompiledModuleMapFromAuthoredSource({
      authoredAppRoot: input.appRoot,
      compiledArtifactsSource: builtArtifactsSource,
    }),
  ]);

  await withBundledCompiledArtifacts(
    {
      manifest,
      metadata: metadata ?? undefined,
      moduleMap,
      sessionId: "built-app-prewarm",
    },
    async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const graph = await resolveRuntimeAgentGraph({
        manifest,
        moduleMap,
      });

      await prewarmSandboxes({
        appRoot: input.appRoot,
        compileDirectoryPath:
          resolveRuntimeCompilerArtifactPaths(builtArtifactsRoot).compileDirectoryPath,
        compiledArtifactsSource,
        dispatch: input.dispatch,
        graph,
        log: input.log,
      });
    },
  );

  const sandboxPreparedArtifacts = await loadSandboxPreparedArtifactsManifest(builtArtifactsSource);
  if (sandboxPreparedArtifacts !== null) {
    updateBundledSandboxPreparedArtifacts(sandboxPreparedArtifacts);
  }
}

async function collectPrewarmTargets(input: {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly force?: boolean;
  readonly graph: ResolvedAgentGraphBundle;
}): Promise<readonly PrewarmTarget[]> {
  const targets: PrewarmTarget[] = [];

  await Promise.all(
    collectNodeSandboxes(input.graph).map(async ({ definition, nodeId, workspaceResourceRoot }) => {
      const resolvedAgentRoot =
        nodeId === ROOT_RUNTIME_AGENT_NODE_ID
          ? join(input.appRoot, "agent")
          : join(input.appRoot, "agent", nodeId);
      const dockerfile =
        definition.environment.kind === "dockerfile"
          ? await resolveSandboxDockerfile(resolvedAgentRoot)
          : undefined;
      const templatePlan = createRuntimeSandboxTemplatePlan({
        definition,
        workspaceResourceRoot,
      });
      const provider = getSandboxEnvironmentRuntime(definition.environment);
      const preparation = getSandboxEnvironmentPreparation(definition.environment);
      const templateKey = await createRuntimeSandboxTemplateKey({
        providerName: definition.environment.provider,
        compiledArtifactsSource: input.compiledArtifactsSource,
        configurationHash: getSandboxEnvironmentConfigurationHash(definition.environment),
        nodeId,
        sourceId: definition.sourceId,
        templatePlan,
      });

      if (templateKey === null) {
        return;
      }

      const seedFiles = await loadResourceRootSeedFiles({
        compileDirectoryPath: input.compileDirectoryPath,
        workspaceResourceRoot,
      });
      targets.push({
        context: {
          appRoot: input.appRoot,
          dockerfile,
          force: input.force,
          resources: createSandboxProviderResources({
            resourcesKey: workspaceResourceRoot.contentHash,
            resourcesPath:
              workspaceResourceRoot.contentHash === undefined
                ? undefined
                : `${input.compileDirectoryPath}/${workspaceResourceRoot.logicalPath}`,
            seedFiles,
          }),
          runPreparation: async (sandbox) => await preparation?.(sandbox),
          templateName: templateKey,
        },
        label: formatLabel(nodeId),
        provider,
        signature: `${definition.environment.provider}:${nodeId}:${templateKey}`,
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

function createPrewarmSignature(targets: readonly PrewarmTarget[]): string {
  return targets
    .map((target) => target.signature)
    .sort()
    .join("\n");
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
