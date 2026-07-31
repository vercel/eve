import { writeFile } from "node:fs/promises";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledWorkspaceResourceRoot,
} from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
  type RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { type ResolvedAgentGraphBundle, ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import {
  createRuntimeSandboxDefinitionRevision,
  createRuntimeSandboxTemplateKey,
} from "#runtime/sandbox/keys.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import {
  writeSandboxSeedFiles,
  type SandboxSeedFile,
} from "#execution/sandbox/bindings/local-workspace-utils.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import {
  getSandboxTemplateInternal,
  type InternalSandboxTemplate,
  type SandboxTemplatePrewarmInput,
} from "#shared/sandbox-template.js";
import { toErrorMessage } from "#shared/errors.js";
import { withSandboxTemplatePrewarmLock } from "./template-prewarm-lock.js";

interface PrewarmTarget {
  readonly exportName: string;
  readonly input: SandboxTemplatePrewarmInput;
  readonly label: string;
  readonly nodeId: string;
  readonly signature: string;
  readonly template: InternalSandboxTemplate;
  readonly templateKey: string;
}

export interface PrewarmedSandboxTemplateBinding {
  readonly exportName: string;
  readonly nodeId: string;
  readonly reference: JsonValue;
  readonly templateKey: string;
}

interface NodeSandbox extends RuntimeRegisteredSandbox {
  readonly nodeId: string;
}

/**
 * Optional test/build dispatch around one provider template prewarm.
 */
export type SandboxTemplatePrewarmDispatch = (input: {
  readonly prewarm: () => Promise<unknown>;
  readonly templateKey: string;
}) => Promise<unknown>;

interface PrewarmSandboxesInput {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxTemplatePrewarmDispatch;
  readonly onPrewarmSignature?: (
    signature: string,
    bindings: readonly PrewarmedSandboxTemplateBinding[],
  ) => void;
  readonly reusePrewarmSignature?: (
    signature: string,
  ) => readonly PrewarmedSandboxTemplateBinding[] | undefined;
}

/**
 * Prewarms every exported sandbox template in a resolved agent graph.
 */
export async function prewarmSandboxes(
  input: PrewarmSandboxesInput,
): Promise<readonly PrewarmedSandboxTemplateBinding[]> {
  const targets = await collectPrewarmTargets(input);
  if (targets.length === 0) {
    return [];
  }

  const signature = createPrewarmSignature(targets);
  const reusedBindings = input.reusePrewarmSignature?.(signature);
  if (reusedBindings !== undefined) {
    return reusedBindings;
  }

  input.log?.(`eve: initializing ${formatSandboxTemplateCount(targets.length)}...`);
  const bindings = await Promise.all(
    targets.map(async (target) => {
      const runPrewarm = async () => await target.template.prewarm(target.input);

      try {
        const reference = await withSandboxTemplatePrewarmLock(
          {
            appRoot: input.appRoot,
            provider: target.template.implementationId,
            templateKey: target.templateKey,
          },
          async () =>
            input.dispatch === undefined
              ? await runPrewarm()
              : await input.dispatch({
                  prewarm: runPrewarm,
                  templateKey: target.templateKey,
                }),
        );
        return {
          exportName: target.exportName,
          nodeId: target.nodeId,
          reference: parseJsonValue(reference),
          templateKey: target.templateKey,
        };
      } catch (error) {
        input.log?.(
          `eve: failed to initialize sandbox template "${target.label}": ${toErrorMessage(error)}`,
        );
        throw error;
      }
    }),
  );
  input.log?.(`eve: initialized ${formatSandboxTemplateCount(targets.length)}.`);
  input.onPrewarmSignature?.(signature, bindings);
  return bindings;
}

export async function prewarmAppSandboxes(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  readonly loadAgentGraph?: (input: {
    readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
  }) => Promise<ResolvedAgentGraphBundle>;
  readonly log?: (message: string) => void;
  readonly dispatch?: SandboxTemplatePrewarmDispatch;
  readonly onPrewarmSignature?: (
    signature: string,
    bindings: readonly PrewarmedSandboxTemplateBinding[],
  ) => void;
  readonly reusePrewarmSignature?: (
    signature: string,
  ) => readonly PrewarmedSandboxTemplateBinding[] | undefined;
}): Promise<readonly PrewarmedSandboxTemplateBinding[]> {
  const compiledArtifactsSource =
    input.compiledArtifactsSource ??
    createAuthoredSourceRuntimeCompiledArtifactsSource(input.appRoot);
  if (compiledArtifactsSource.kind !== "disk") {
    throw new Error("prewarmAppSandboxes requires disk-backed compiled artifacts.");
  }
  const graph = await (input.loadAgentGraph ?? loadGraphFromArtifacts)({
    compiledArtifactsSource,
  });

  const bindings = await prewarmSandboxes({
    appRoot: getRuntimeCompiledArtifactsSandboxAppRoot(compiledArtifactsSource) ?? input.appRoot,
    compileDirectoryPath: resolveRuntimeCompilerArtifactPaths(compiledArtifactsSource.appRoot)
      .compileDirectoryPath,
    compiledArtifactsSource,
    dispatch: input.dispatch,
    graph,
    log: input.log,
    onPrewarmSignature: input.onPrewarmSignature,
    reusePrewarmSignature: input.reusePrewarmSignature,
  });
  await writeSandboxTemplateBindings({
    bindings,
    compiledArtifactsSource,
  });
  return bindings;
}

async function collectPrewarmTargets(input: {
  readonly appRoot: string;
  readonly compileDirectoryPath: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly graph: ResolvedAgentGraphBundle;
  readonly log?: (message: string) => void;
}): Promise<readonly PrewarmTarget[]> {
  const targets: PrewarmTarget[] = [];

  await Promise.all(
    collectNodeSandboxes(input.graph).map(async ({ definition, nodeId, workspaceResourceRoot }) => {
      const seedFiles = await loadResourceRootSeedFiles({
        compileDirectoryPath: input.compileDirectoryPath,
        workspaceResourceRoot,
      });
      if (definition.templates.length === 0) {
        if (seedFiles.length > 0) {
          throw new Error(
            `Sandbox "${definition.logicalPath}" has a managed workspace but exports no SandboxTemplate.`,
          );
        }
        return;
      }

      const revision = await createRuntimeSandboxDefinitionRevision({
        nodeId,
        sourceHash: definition.sourceHash,
        sourceId: definition.sourceId,
        workspaceResourceRoot,
      });

      await Promise.all(
        definition.templates.map(async ({ exportName, template }) => {
          const internal = getSandboxTemplateInternal(template);
          const label = `${formatLabel(nodeId)}:${exportName}`;
          const templateKey = await createRuntimeSandboxTemplateKey({
            compiledArtifactsSource: input.compiledArtifactsSource,
            exportName,
            implementationId: internal.implementationId,
            nodeId,
            revision,
          });
          targets.push({
            exportName,
            input: {
              appRoot: input.appRoot,
              assets: {},
              hydrate: async (sandbox) => await writeSandboxSeedFiles(sandbox, seedFiles),
              ...(input.log === undefined
                ? {}
                : {
                    log: (message: string) =>
                      input.log?.(`eve: sandbox template "${label}": ${message}`),
                  }),
              templateId: templateKey,
            },
            label,
            nodeId,
            signature: `${internal.implementationId}:${nodeId}:${exportName}:${templateKey}`,
            template: internal,
            templateKey,
          });
        }),
      );
    }),
  );

  return targets.sort((left, right) => left.label.localeCompare(right.label));
}

async function writeSandboxTemplateBindings(input: {
  readonly bindings: readonly PrewarmedSandboxTemplateBinding[];
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
}): Promise<void> {
  if (input.bindings.length === 0) {
    return;
  }
  const paths = resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot);
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: input.compiledArtifactsSource,
  });
  const nextManifest = applySandboxTemplateBindings(manifest, input.bindings);
  await writeFile(paths.compiledManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

function applySandboxTemplateBindings(
  manifest: CompiledAgentManifest,
  bindings: readonly PrewarmedSandboxTemplateBinding[],
): CompiledAgentManifest {
  const byNodeId = new Map<string, PrewarmedSandboxTemplateBinding[]>();
  for (const binding of bindings) {
    const existing = byNodeId.get(binding.nodeId);
    if (existing === undefined) {
      byNodeId.set(binding.nodeId, [binding]);
    } else {
      existing.push(binding);
    }
  }

  const bindNode = (node: CompiledAgentNodeManifest, nodeId: string): CompiledAgentNodeManifest => {
    const nodeBindings = byNodeId.get(nodeId) ?? [];
    return {
      ...node,
      sandboxTemplateReferences: {
        ...node.sandboxTemplateReferences,
        ...Object.fromEntries(
          nodeBindings.map((binding) => [binding.exportName, binding.reference]),
        ),
      },
    };
  };

  const root = bindNode(manifest, ROOT_RUNTIME_AGENT_NODE_ID);
  return {
    ...manifest,
    ...root,
    subagents: manifest.subagents.map((subagent) => ({
      ...subagent,
      agent: bindNode(subagent.agent, subagent.nodeId),
    })),
  };
}

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
  return await resolveRuntimeAgentGraph({ manifest, moduleMap });
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
