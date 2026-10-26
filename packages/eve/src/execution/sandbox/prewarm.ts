import { join, relative, resolve } from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import { copyDirectoryAtomically } from "#execution/sandbox/bindings/local-provider-utils.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { createConnectionSession } from "#execution/sandbox/session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import type {
  SandboxJson,
  SandboxPrepareContext,
  SandboxProviderRuntime,
} from "#sandbox/provider.js";
import type {
  SandboxProviderFiles,
  SandboxProviderResourceFile,
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
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import type { SandboxPreparedArtifactEntry } from "#shared/sandbox-prepared-artifacts.js";
import { writeSandboxPreparedArtifactsManifest } from "#runtime/sandbox/prepared-artifacts.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import { toErrorMessage } from "#shared/errors.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { MODEL_SKILL_ROOT, resolveSandboxModelPath } from "#shared/skill-paths.js";

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
  readonly files: SandboxProviderFiles;
  readonly label: string;
  readonly nodeId: string;
  readonly provider: SandboxProviderRuntime;
  readonly resources: SandboxTemplateResources;
  readonly sourceRevision: string;
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
  readonly context: SandboxPrepareContext;
  readonly provider: SandboxProviderRuntime;
}) => Promise<SandboxJson>;

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
    targets.map(async ({ label, nodeId, provider, ...target }) => {
      const logProviderProgress = (message: string) => {
        if (!shouldLogSandboxPrewarmProgress(message)) return;
        input.log?.(`eve: sandbox template "${label}" (${provider.providerName}): ${message}`);
      };
      try {
        const result = await dispatch({
          context: createSandboxPrepareContext({
            ...target,
            appRoot: input.appRoot,
            log: logProviderProgress,
            provider,
            storagePath: resolveSandboxCacheDirectory(input.appRoot),
          }),
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
        files: createSandboxProviderFiles(sandboxRoot),
        label: formatLabel(nodeId),
        nodeId,
        provider,
        resources,
        sourceRevision: definition.revisionHash,
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
}): Promise<SandboxTemplateResources> {
  const { contentHash, logicalPath } = input.workspaceResourceRoot;
  if (contentHash === undefined) return {};
  const path = `${input.compileDirectoryPath}/${logicalPath}`;
  return { key: contentHash, path, ...(await materializeWorkspaceDirectory(path)) };
}

/** The compiled workspace and skill files one sandbox template seeds. */
export interface SandboxTemplateResources {
  /** The compiled resource tree's content hash; absent when the agent has none. */
  readonly key?: string;
  /** The compiled resource directory on the host, holding `workspace/` and `skills/`. */
  readonly path?: string;
  readonly skills?: readonly SandboxProviderResourceFile[];
  readonly workspace?: readonly SandboxProviderResourceFile[];
}

/** The context eve passes to a provider's `prepare()` for one template. */
export function createSandboxPrepareContext(input: {
  readonly appRoot: string;
  readonly files: SandboxProviderFiles;
  readonly log: (message: string) => void;
  readonly provider: Pick<SandboxProviderRuntime, "prepare" | "providerName">;
  readonly resources: SandboxTemplateResources;
  readonly sourceRevision: string;
  readonly storagePath: string;
}): SandboxPrepareContext {
  const { log, resources, storagePath } = input;
  const { prepare } = input.provider;
  const workspace = resources.workspace ?? [];
  const skills = resources.skills ?? [];
  const resourcesPath = resources.key === undefined ? undefined : resources.path;
  return {
    files: input.files,
    isEmpty: workspace.length === 0 && skills.length === 0 && prepare === undefined,
    log,
    async populate(connection, options) {
      const session = createConnectionSession(connection);
      // Without a resource directory there is nothing mounted to copy from.
      if (options?.mountedAt !== undefined && resourcesPath !== undefined) {
        log("copying workspace and skills from mounted resources");
        await copyMountedResources(session, shellQuote(options.mountedAt));
      } else if (workspace.length > 0 || skills.length > 0) {
        log("writing workspace and skills");
        const bytes = (file: SandboxProviderResourceFile) =>
          typeof file.content === "string" ? Buffer.from(file.content) : file.content;
        await session.writeFiles({
          files: [
            // A workspace file named like `$HOME/...` still lands under the workspace root.
            ...workspace.map((file) => ({
              content: bytes(file),
              path: session.resolvePath(file.relativePath),
            })),
            ...(await Promise.all(
              skills.map(async (file) => ({
                content: bytes(file),
                path: await resolveSandboxModelPath({
                  path: `${MODEL_SKILL_ROOT}/${file.relativePath}`,
                  sandbox: session,
                }),
              })),
            )),
          ],
        });
      }
      if (prepare === undefined) return;
      log("running sandbox preparation");
      await prepare(createLoggingSandboxSession({ log, session }));
    },
    resolveProjectPath: (path) => resolve(input.appRoot, path),
    async resourcesDirectory() {
      if (resources.key === undefined || resourcesPath === undefined) return undefined;
      const directory = join(storagePath, input.provider.providerName, "resources", resources.key);
      await copyDirectoryAtomically(resourcesPath, directory);
      return directory;
    },
    storagePath,
    templateKey(identity) {
      assertSandboxIdentity(identity, "identity", new WeakSet());
      for (const reserved of ["resources", "sourceRevision"]) {
        if (Object.hasOwn(identity, reserved)) {
          throw new Error(
            `ctx.templateKey() reserves "${reserved}": eve adds the workspace and skill files and the sandbox source revision itself. Rename that identity field.`,
          );
        }
      }
      const key = resources.key;
      return createSandboxProviderIdentity({
        ...identity,
        resources: {
          skills: key === undefined ? undefined : `${key}:skills`,
          workspace: key === undefined ? undefined : `${key}:workspace`,
        },
        sourceRevision: input.sourceRevision,
      });
    },
  };
}

/** `quotedRoot` is interpolated into the shell script, so callers pass it shell-quoted. */
async function copyMountedResources(session: SandboxSession, quotedRoot: string): Promise<void> {
  const workspace = shellQuote(session.resolvePath("."));
  const result = await session.run({
    command: [
      "set -e",
      `if [ -d ${quotedRoot}/workspace ]; then cp -a ${quotedRoot}/workspace/. ${workspace}/; fi`,
      `if [ -d ${quotedRoot}/skills ]; then`,
      '  mkdir -p "$HOME/.agents"',
      '  rm -rf "$HOME/.agents/skills"',
      '  mkdir -p "$HOME/.agents/skills"',
      `  cp -a ${quotedRoot}/skills/. "$HOME/.agents/skills/"`,
      "fi",
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to hydrate sandbox resources: ${result.stderr || result.stdout}`);
  }
}

/**
 * Rejects what the template-key hasher cannot tell apart, such as a `Date` or
 * `Map` that would hash as `{}`, and circular values, before hashing.
 */
function assertSandboxIdentity(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || value === undefined || typeof value === "function") return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const prototype = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  const plain = Array.isArray(value) || prototype === Object.prototype || prototype === null;
  if (typeof value !== "object" || !plain) {
    throw new Error(
      `ctx.templateKey() accepts only JSON values, plain objects, arrays, and functions, but ${path} is ${describeIdentityValue(value)}. Pass a JSON form, such as a string.`,
    );
  }
  if (seen.has(value))
    throw new Error(`ctx.templateKey() cannot hash a circular value at ${path}.`);
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    assertSandboxIdentity(entry, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function describeIdentityValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return `a ${value.constructor?.name ?? "non-plain object"}`;
  }
  return typeof value === "number" ? String(value) : `a ${typeof value}`;
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
