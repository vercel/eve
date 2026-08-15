import { join } from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import type {
  SandboxBackend,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
  SandboxSeedFile,
} from "#public/definitions/sandbox-backend.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { type ResolvedAgentGraphBundle, ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { loadCompileMetadata } from "#runtime/loaders/compile-metadata.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { createRuntimeSandboxTemplateKey } from "#runtime/sandbox/keys.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import { toErrorMessage } from "#shared/errors.js";
import { withSandboxTemplatePrewarmLock } from "./template-prewarm-lock.js";

interface PrewarmTarget {
  readonly backend: SandboxBackend;
  readonly label: string;
  readonly input: SandboxBackendPrewarmInput;
  readonly signature: string;
}

interface NodeSandbox extends RuntimeRegisteredSandbox {
  readonly nodeId: string;
}

/**
 * Optional dispatch override that intercepts every `backend.prewarm`
 * call. Production code never supplies this; the orchestrator dispatches
 * directly to the backend. Tests inject a recorder to verify which
 * templates the orchestrator emits and what bootstrap calls flow through
 * them.
 */
export type SandboxBackendPrewarmDispatch = (input: {
  readonly backend: SandboxBackend;
  readonly input: SandboxBackendPrewarmInput;
}) => Promise<SandboxBackendPrewarmResult>;

interface PrewarmSandboxesInput {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxBackendPrewarmDispatch;
  readonly onPrewarmSignature?: (signature: string) => void;
  readonly shouldPrewarmSignature?: (signature: string) => boolean;
}

/**
 * Prewarms every backend sandbox template required by one compiled
 * runtime graph.
 *
 * Iterates every registered sandbox and invokes `backend.prewarm(...)`
 * for each backend template.
 */
export async function prewarmSandboxes(input: PrewarmSandboxesInput): Promise<void> {
  const targets = await collectPrewarmTargets(input);

  if (targets.length === 0) {
    return;
  }

  const signature = createPrewarmSignature(targets);
  if (input.shouldPrewarmSignature?.(signature) === false) {
    return;
  }

  const dispatch =
    input.dispatch ??
    (async ({ backend, input: prewarmInput }) => {
      return await backend.prewarm(prewarmInput);
    });

  input.log?.(`eve: initializing ${formatSandboxTemplateCount(targets.length)}...`);

  const results = await Promise.all(
    targets.map(async ({ backend, label, input: prewarmInput }) => {
      const logBackendProgress = (message: string) => {
        if (!shouldLogSandboxPrewarmProgress(message)) {
          return;
        }
        input.log?.(`eve: sandbox template "${label}" (${backend.name}): ${message}`);
      };
      let result: SandboxBackendPrewarmResult;
      try {
        result = await withSandboxTemplatePrewarmLock(
          {
            appRoot: prewarmInput.runtimeContext.appRoot,
            backendName: backend.name,
            templateKey: prewarmInput.templateKey,
          },
          async () => {
            return await dispatch({
              backend,
              input: {
                ...prewarmInput,
                log: input.log === undefined ? undefined : logBackendProgress,
              },
            });
          },
        );
      } catch (error) {
        const prewarmError = formatPrewarmFailureForEnvironment({
          backendName: backend.name,
          error,
        });
        input.log?.(
          `eve: failed to initialize sandbox template "${label}" on backend "${backend.name}": ${toErrorMessage(prewarmError)}`,
        );
        throw prewarmError;
      }
      return result;
    }),
  );
  const reusedCount = results.filter((result) => result.reused).length;
  input.log?.(
    `eve: initialized ${formatSandboxTemplateCount(targets.length)} (${reusedCount} reused, ${
      targets.length - reusedCount
    } built).`,
  );
  input.onPrewarmSignature?.(signature);
}

/**
 * Loads the compiled runtime graph for one authored app root and
 * prewarms every backend's sandbox templates required by that graph.
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
  readonly dispatch?: SandboxBackendPrewarmDispatch;
  readonly onPrewarmSignature?: (signature: string) => void;
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
    graph,
    log: input.log,
    onPrewarmSignature: input.onPrewarmSignature,
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
  readonly dispatch?: SandboxBackendPrewarmDispatch;
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
}

async function collectPrewarmTargets(input: {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
}): Promise<readonly PrewarmTarget[]> {
  const runtimeContext = { appRoot: input.appRoot };

  const targets: PrewarmTarget[] = [];

  await Promise.all(
    collectNodeSandboxes(input.graph).map(async ({ definition, nodeId, workspaceResourceRoot }) => {
      const templatePlan = createRuntimeSandboxTemplatePlan({
        definition,
        workspaceResourceRoot,
      });
      const templateKey = await createRuntimeSandboxTemplateKey({
        backendName: definition.backend.name,
        compiledArtifactsSource: input.compiledArtifactsSource,
        nodeId,
        sourceId: definition.sourceId,
        templatePlan,
      });

      if (templateKey === null) {
        return;
      }

      targets.push({
        backend: definition.backend,
        label: formatLabel(nodeId),
        input: {
          bootstrap: definition.bootstrap,
          seedFiles: await loadResourceRootSeedFiles({
            compileDirectoryPath: input.compileDirectoryPath,
            workspaceResourceRoot,
          }),
          runtimeContext,
          templateKey,
        },
        signature: `${definition.backend.name}:${nodeId}:${templateKey}`,
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
 * `{path, content}` shape consumed by sandbox backends.
 *
 * Returns an empty array when the resource root descriptor advertises no
 * root entries (the materializer would emit no files anyway).
 */
async function loadResourceRootSeedFiles(input: {
  readonly compileDirectoryPath: string;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): Promise<readonly SandboxSeedFile[]> {
  if (
    input.workspaceResourceRoot.contentHash === undefined &&
    input.workspaceResourceRoot.rootEntries.length === 0
  ) {
    return [];
  }
  const materialized = await materializeWorkspaceDirectory(
    `${input.compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}`,
  );
  return materialized.map((file) => ({
    content: file.content,
    path: file.path,
  }));
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
    return registered === null ? [] : [{ ...registered, nodeId }];
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
  readonly backendName: string;
  readonly error: unknown;
}): unknown {
  if (!isVercelEnvironment() || !isLocalSandboxBackend(input.backendName)) {
    return input.error;
  }

  return new Error(
    `The ${input.backendName} sandbox backend is not available when deploying on Vercel. ` +
      "Vercel build containers cannot run local Docker containers or microsandbox VMs. " +
      "Use defaultBackend() so eve selects Vercel Sandbox on Vercel, or configure a " +
      "Vercel-compatible backend explicitly, such as vercel(). " +
      `Original ${input.backendName} error: ${toErrorMessage(input.error)}`,
    { cause: input.error },
  );
}

function isVercelEnvironment(): boolean {
  return Boolean(process.env.VERCEL?.trim());
}

function isLocalSandboxBackend(backendName: string): boolean {
  return backendName === "docker" || backendName === "microsandbox";
}
