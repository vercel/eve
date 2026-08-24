import type { AgentSourceManifest, LocalSubagentSourceRef } from "#discover/manifest.js";
import {
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledRemoteAgentNode,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  createCompiledAgentNodeManifest,
  createCompiledAgentResources,
  createCompiledSubagentNodeId,
} from "#compiler/manifest.js";
import type { CompiledDynamicSubagentDefinition } from "#compiler/remote-agent-node.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { normalizeSelectedSource } from "#compiler/normalize-helpers.js";
import {
  prepareAgentConfigPhase,
  isEffectiveModuleSource,
  type AgentNodeSourceOrigin,
  type EffectiveAgentSourceCandidate,
  type PreparedAgentConfigPhase,
} from "#compiler/effective-agent-source-graph.js";
import type {
  CompileAgentNodeOptions,
  CompileAgentResourcesOptions,
} from "#compiler/normalize-manifest.js";
import {
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { serializeOutputSchema, type ToolSchemaSource } from "#shared/tool-schema.js";
import type { JsonObject } from "#shared/json.js";
import {
  ALLOWED_DYNAMIC_SUBAGENT_EVENTS,
  isDynamicSentinel,
  type DynamicToolEventName,
} from "#shared/dynamic-tool-definition.js";
import type { KernelSemanticSubagentSource } from "#compiler/kernel-plan-semantics.js";
import { withSelectedConfigExternalDependencies } from "#compiler/compiled-external-dependencies.js";

export interface SelectedSubagentSource {
  readonly candidate: EffectiveAgentSourceCandidate;
  readonly source: LocalSubagentSourceRef;
}

export function toKernelSemanticSubagentSources(
  selected: readonly SelectedSubagentSource[],
): readonly KernelSemanticSubagentSource[] {
  return selected.map(({ candidate, source }) => {
    if (candidate.descriptor.sourceKind !== "subagent") {
      throw new Error(`Selected source "${candidate.descriptor.sourceId}" is not a subagent.`);
    }
    return {
      backing: candidate.descriptor.backing,
      logicalPath: source.logicalPath,
      name: source.subagentId,
      owner: candidate.descriptor.owner,
      sourceId: source.sourceId,
    };
  });
}

export interface CompiledAgentNodeCompilation {
  readonly agent: CompiledAgentNodeManifest;
  readonly subagents: readonly SelectedSubagentSource[];
}

export interface CompiledAgentResourcesCompilation {
  readonly resources: CompiledAgentResources;
  readonly subagents: readonly SelectedSubagentSource[];
}

export type CompileAgentNodeManifestFn = (
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentNodeOptions,
) => Promise<CompiledAgentNodeCompilation>;

export type CompileAgentResourcesFn = (
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: CompileAgentResourcesOptions,
) => Promise<CompiledAgentResourcesCompilation>;

export async function compileSubagentGraph(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly parentNodeId: string;
  readonly subagents: readonly SelectedSubagentSource[];
}): Promise<{
  readonly edges: readonly CompiledSubagentEdge[];
  readonly nodes: readonly CompiledSubagentNode[];
  readonly remoteAgents: readonly CompiledRemoteAgentNode[];
}> {
  const nodes: CompiledSubagentNode[] = [];
  const edges: CompiledSubagentEdge[] = [];
  const remoteAgents: CompiledRemoteAgentNode[] = [];

  for (const selected of input.subagents) {
    const compiled = await normalizeSelectedSource(
      toSubagentNormalizationSource(selected.candidate),
      () => compileSubagentDefinition({ ...input, selected }),
    );
    if (compiled.kind === "remote") {
      remoteAgents.push(compiled.node);
      continue;
    }
    nodes.push(compiled.node, ...compiled.descendants.nodes);
    edges.push(
      { childNodeId: compiled.node.nodeId, parentNodeId: input.parentNodeId },
      ...compiled.descendants.edges,
    );
  }

  return { edges, nodes, remoteAgents };
}

function toSubagentNormalizationSource(candidate: EffectiveAgentSourceCandidate): {
  readonly kind: "subagent";
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly sourcePath?: string;
} {
  const backing = "backing" in candidate.descriptor ? candidate.descriptor.backing : undefined;
  const source = {
    kind: "subagent",
    logicalPath: candidate.descriptor.logicalPath,
    nodeId: candidate.nodeId,
    sourceId: candidate.descriptor.sourceId,
  } as const;
  return backing?.kind === "filesystem" ? { ...source, sourcePath: backing.sourcePath } : source;
}

async function compileSubagentDefinition(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly parentNodeId: string;
  readonly selected: SelectedSubagentSource;
}): Promise<
  | {
      readonly kind: "local";
      readonly descendants: Awaited<ReturnType<typeof compileSubagentGraph>>;
      readonly node: CompiledSubagentNode;
    }
  | {
      readonly kind: "remote";
      readonly node: CompiledRemoteAgentNode;
    }
> {
  const source = input.selected.source;
  const nodeId = createCompiledSubagentNodeId(input.parentNodeId, source.sourceId);
  const origin = childOrigin(input.selected.candidate);
  const sourceManifest = { ...source.manifest, appRoot: input.appRoot };
  const selectedBacking = readSubagentBacking(input.selected.candidate);
  const selectedExternalDependencies = mergeExternalDependencies(
    input.externalDependencies,
    selectedBacking.kind === "filesystem" ? selectedBacking.externalDependencies : [],
  );
  const preparedConfig = await prepareAgentConfigPhase({
    context: input.context,
    externalDependencies: selectedExternalDependencies,
    isRoot: false,
    manifest: sourceManifest,
    nodeId,
    origin,
  });
  const configCandidate = preparedConfig.candidate;
  const dynamic = normalizeDynamicSubagentDefinition(
    preparedConfig.definition,
    `Expected the dynamic subagent config export "${readExportName(configCandidate)}" from "${configCandidate.source.logicalPath}" to match the public eve shape.`,
  );
  if (dynamic === undefined && readAgentDefinitionKind(preparedConfig.definition) === "remote") {
    return compileRemoteAgent({
      configCandidate,
      parentNodeId: input.parentNodeId,
      preparedConfig,
      sourceCandidate: input.selected.candidate,
      source,
      value: preparedConfig.definition,
    });
  }

  return {
    kind: "local",
    ...(await compileLocalSubagent({
      ...input,
      dynamic,
      externalDependencies: selectedExternalDependencies,
      nodeId,
      origin,
      preparedConfig,
      sourceManifest,
    })),
  };
}

async function compileLocalSubagent(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly dynamic?: ReturnType<typeof normalizeDynamicSubagentDefinition>;
  readonly externalDependencies?: readonly string[];
  readonly nodeId: string;
  readonly origin: AgentNodeSourceOrigin;
  readonly parentNodeId: string;
  readonly preparedConfig: PreparedAgentConfigPhase;
  readonly selected: SelectedSubagentSource;
  readonly sourceManifest: AgentSourceManifest;
}): Promise<{
  readonly descendants: Awaited<ReturnType<typeof compileSubagentGraph>>;
  readonly node: CompiledSubagentNode;
}> {
  const source = input.selected.source;
  const configCandidate = input.preparedConfig.candidate;
  const backing = readSubagentBacking(input.selected.candidate);
  const inheritedDependencies = mergeExternalDependencies(
    input.externalDependencies,
    input.dynamic?.build?.externalDependencies,
  );
  const nodeBase = {
    backing,
    entryPath: backing.kind === "filesystem" ? backing.sourcePath : source.entryPath,
    logicalPath: source.logicalPath,
    name: source.subagentId,
    nodeId: input.nodeId,
    owner: input.origin.owner,
    rootPath: source.rootPath,
    sourceId: source.sourceId,
    sourceKind: "subagent" as const,
  };

  if (input.dynamic === undefined) {
    const compilation = await input.compileAgentNodeManifest(input.sourceManifest, input.context, {
      allowRootOnlyConfig: false,
      externalDependencies: inheritedDependencies,
      isRoot: false,
      nodeId: input.nodeId,
      origin: input.origin,
      preparedConfig: input.preparedConfig,
    });
    let agent = compilation.agent;
    const description = agent.config.description;
    if (!description) {
      throw new Error(
        `Local subagent "${source.logicalPath}" requires a model-visible "description". Author its \`agent.ts\` with \`defineAgent({ description, model })\` so the parent agent can decide when to delegate to this subagent.`,
      );
    }
    const descendants = await compileDescendants({
      ...input,
      externalDependencies: mergeExternalDependencies(
        inheritedDependencies,
        agent.config.build?.externalDependencies,
      ),
      subagents: compilation.subagents,
    });
    agent = attachRemoteSources(agent, descendants.remoteAgents, {
      isRoot: false,
      nodeId: input.nodeId,
      subagentSources: toKernelSemanticSubagentSources(compilation.subagents),
    });
    return { descendants, node: { ...nodeBase, agent, description } };
  }

  const configResolver: CompiledDynamicSubagentDefinition = {
    ...toModuleSource(configCandidate),
    ...input.dynamic.definition,
    build: input.dynamic.build,
  };
  const configGraph = withSelectedConfigExternalDependencies(
    input.preparedConfig.graph,
    configCandidate.descriptor.sourceId,
    inheritedDependencies,
  );
  const compilation = await input.compileAgentResources(input.sourceManifest, input.context, {
    additionalConfigReference: configResolver,
    configGraph,
    declaredExternalDependencies: input.dynamic.build?.externalDependencies ?? [],
    externalDependencies: inheritedDependencies,
    isRoot: false,
    nodeId: input.nodeId,
    origin: input.origin,
  });
  let resources = compilation.resources;
  const descendants = await compileDescendants({
    ...input,
    externalDependencies: inheritedDependencies,
    subagents: compilation.subagents,
  });
  resources = attachRemoteSources(resources, descendants.remoteAgents, {
    isRoot: false,
    nodeId: input.nodeId,
    subagentSources: toKernelSemanticSubagentSources(compilation.subagents),
  });
  return { descendants, node: { ...nodeBase, agent: resources, configResolver } };
}

function readSubagentBacking(candidate: EffectiveAgentSourceCandidate) {
  if (candidate.descriptor.sourceKind !== "subagent") {
    throw new Error(`Selected source "${candidate.descriptor.sourceId}" is not a subagent.`);
  }
  return candidate.descriptor.backing;
}

async function compileDescendants(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly nodeId: string;
  readonly subagents: readonly SelectedSubagentSource[];
}): Promise<Awaited<ReturnType<typeof compileSubagentGraph>>> {
  return await compileSubagentGraph({
    appRoot: input.appRoot,
    compileAgentNodeManifest: input.compileAgentNodeManifest,
    compileAgentResources: input.compileAgentResources,
    context: input.context,
    externalDependencies: input.externalDependencies,
    parentNodeId: input.nodeId,
    subagents: input.subagents,
  });
}

export function attachRemoteSources<T extends CompiledAgentNodeManifest | CompiledAgentResources>(
  resources: T,
  remoteAgents: readonly CompiledRemoteAgentNode[],
  options: {
    readonly isRoot: boolean;
    readonly nodeId: string;
    readonly subagentSources?: readonly KernelSemanticSubagentSource[];
  },
): T {
  if (remoteAgents.length === 0) return resources;
  const input = {
    ...resources,
    remoteAgents: [...resources.remoteAgents, ...remoteAgents],
  };
  return (
    "config" in resources
      ? createCompiledAgentNodeManifest(
          input as Parameters<typeof createCompiledAgentNodeManifest>[0],
          options,
        )
      : createCompiledAgentResources(input, options)
  ) as T;
}

function compileRemoteAgent(input: {
  readonly configCandidate: EffectiveAgentSourceCandidate;
  readonly parentNodeId: string;
  readonly preparedConfig: PreparedAgentConfigPhase;
  readonly sourceCandidate: EffectiveAgentSourceCandidate;
  readonly source: LocalSubagentSourceRef;
  readonly value: unknown;
}): {
  readonly kind: "remote";
  readonly node: CompiledRemoteAgentNode;
} {
  assertRemoteAgentDefinitionHasNoLocalPackageEntries(input.source);
  const definition = normalizeRemoteAgentDefinition(
    input.value,
    `Expected the remote agent config export "${readExportName(input.configCandidate)}" from "${input.configCandidate.source.logicalPath}" to match the public eve shape.`,
  );
  const moduleSource = toModuleSource(input.configCandidate);
  const backing = readSubagentBacking(input.sourceCandidate);
  const nodeBase: CompiledRemoteAgentNode = {
    backing,
    bindings: input.preparedConfig.graph.bindings,
    configResolver: moduleSource,
    description: definition.description,
    entryPath: backing.kind === "filesystem" ? backing.sourcePath : input.source.entryPath,
    logicalPath: input.source.logicalPath,
    name: input.source.subagentId,
    nodeId: createCompiledSubagentNodeId(input.parentNodeId, input.source.sourceId),
    owner: input.sourceCandidate.descriptor.owner,
    outputSchema: definition.outputSchema,
    path: definition.path,
    rootPath: input.source.rootPath,
    sourceId: input.source.sourceId,
    sourceKind: "subagent",
    sourceComposition: input.preparedConfig.graph.composition,
  };
  const node = definition.url === undefined ? nodeBase : { ...nodeBase, url: definition.url };
  return { kind: "remote", node };
}

function childOrigin(candidate: EffectiveAgentSourceCandidate): AgentNodeSourceOrigin {
  if (candidate.descriptor.sourceKind !== "subagent") {
    throw new Error(`Selected source "${candidate.descriptor.sourceId}" is not a subagent source.`);
  }
  const origin: {
    extensionScope?: AgentNodeSourceOrigin["extensionScope"];
    layer: AgentNodeSourceOrigin["layer"];
    owner: AgentNodeSourceOrigin["owner"];
  } = {
    layer: candidate.descriptor.layer,
    owner: candidate.descriptor.owner,
  };
  if (
    candidate.descriptor.backing.kind === "filesystem" &&
    candidate.descriptor.backing.extensionScope !== undefined
  ) {
    origin.extensionScope = candidate.descriptor.backing.extensionScope;
  }
  return origin;
}

function toModuleSource(candidate: EffectiveAgentSourceCandidate) {
  if (!isEffectiveModuleSource(candidate.source)) {
    throw new Error(`Subagent config source "${candidate.descriptor.sourceId}" must be a module.`);
  }
  return candidate.source;
}

function readOptionalExportName(candidate: EffectiveAgentSourceCandidate): string | undefined {
  return isEffectiveModuleSource(candidate.source) ? candidate.source.exportName : undefined;
}

function readExportName(candidate: EffectiveAgentSourceCandidate): string {
  return readOptionalExportName(candidate) ?? "default";
}

function normalizeDynamicSubagentDefinition(
  value: unknown,
  message: string,
):
  | {
      readonly build?: { readonly externalDependencies?: readonly string[] };
      readonly definition: { readonly eventNames: readonly DynamicToolEventName[] };
    }
  | undefined {
  if (!isDynamicSentinel(value)) return undefined;
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["build", "events", "kind"], message);
  const build =
    record.build === undefined ? undefined : normalizeDynamicSubagentBuild(record.build, message);
  const rawEvents = expectObjectRecord(record.events, message);
  const eventNames: DynamicToolEventName[] = [];
  for (const [eventName, handler] of Object.entries(rawEvents)) {
    if (!ALLOWED_DYNAMIC_SUBAGENT_EVENTS.has(eventName as DynamicToolEventName)) {
      throw new Error(
        `${message} Dynamic subagents support only "session.started" and "turn.started" handlers.`,
      );
    }
    expectFunction(handler, message);
    eventNames.push(eventName as DynamicToolEventName);
  }
  return build === undefined
    ? { definition: { eventNames } }
    : { build, definition: { eventNames } };
}

function normalizeDynamicSubagentBuild(
  value: unknown,
  message: string,
): { readonly externalDependencies?: readonly string[] } {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["externalDependencies"], message);
  if (record.externalDependencies === undefined) return {};
  if (!Array.isArray(record.externalDependencies)) throw new Error(message);
  return {
    externalDependencies: record.externalDependencies.map((entry) => expectString(entry, message)),
  };
}

function readAgentDefinitionKind(value: unknown): "local" | "remote" {
  return value !== null &&
    typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "remote"
    ? "remote"
    : "local";
}

function normalizeRemoteAgentDefinition(
  value: unknown,
  message: string,
): {
  readonly description: string;
  readonly outputSchema?: JsonObject;
  readonly path: string;
  readonly url?: string;
} {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(
    record,
    ["auth", "description", "forwardPrincipal", "headers", "kind", "outputSchema", "path", "url"],
    message,
  );
  if (record.kind !== "remote") throw new Error(`${message} Expected "kind" to be "remote".`);
  if (record.forwardPrincipal !== undefined) {
    expectBoolean(
      record.forwardPrincipal,
      `${message} Expected "forwardPrincipal" to be a boolean.`,
    );
  }
  const url = typeof record.url === "function" ? undefined : expectString(record.url, message);
  if (url !== undefined && url.length === 0) {
    throw new Error(`${message} Expected "url" to be a non-empty string or function.`);
  }
  return {
    description: expectString(record.description, message),
    outputSchema: serializeOutputSchema(record.outputSchema as ToolSchemaSource | undefined),
    path: record.path === undefined ? EVE_SESSION_ROUTE_PATH : expectString(record.path, message),
    url,
  };
}

function assertRemoteAgentDefinitionHasNoLocalPackageEntries(source: LocalSubagentSourceRef): void {
  const manifest = source.manifest;
  const extraEntries = [
    manifest.connections.length > 0 ? "connections/" : undefined,
    manifest.extensions.length > 0 || manifest.resolvedExtensions.length > 0
      ? "extensions/"
      : undefined,
    manifest.hooks.length > 0 ? "hooks/" : undefined,
    manifest.instructions.length > 0 ? "instructions" : undefined,
    manifest.lib.length > 0 ? "lib/" : undefined,
    manifest.sandbox !== null ? "sandbox/" : undefined,
    manifest.sandboxWorkspaces.length > 0 ? "sandbox/workspace/" : undefined,
    manifest.schedules.length > 0 ? "schedules/" : undefined,
    manifest.skills.length > 0 ? "skills/" : undefined,
    manifest.subagents.length > 0 ? "subagents/" : undefined,
    manifest.tools.length > 0 ? "tools/" : undefined,
  ].filter((entry) => entry !== undefined);
  if (extraEntries.length === 0) return;
  throw new Error(
    `Remote subagent definition "${source.logicalPath}" cannot include local package entries. Remove unsupported entries: ${extraEntries.join(", ")}.`,
  );
}

function mergeExternalDependencies(
  ...lists: ReadonlyArray<readonly string[] | undefined>
): readonly string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}
