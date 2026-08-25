import { join, relative } from "node:path";

import { createPathDerivedSourceId, type LocalSubagentSourceRef } from "#discover/manifest.js";
import {
  type CompiledRemoteAgentNode,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  createCompiledAgentResources,
  createCompiledSubagentNodeId,
} from "#compiler/manifest.js";
import type { ComposedCandidate, NodeExtensionScope } from "#compiler/compose-sources.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import type { CompiledDynamicSubagentDefinition } from "#compiler/remote-agent-node.js";
import {
  loadComposedModuleDefinition,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";
import { assembleCompiledNodeManifest } from "#compiler/normalize-manifest.js";
import type { CompileAgentNodePartsFn } from "#compiler/normalize-manifest.js";
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
import { isDynamicSentinel, type DynamicToolEventName } from "#shared/dynamic-tool-definition.js";

const ALLOWED_DYNAMIC_SUBAGENT_EVENTS = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
]);

/**
 * One selected local subagent candidate plus the extension identity it
 * threads into the child node's own composition.
 */
export interface SubagentSelection {
  readonly candidate: ComposedCandidate;
  readonly nodeExtensionScope?: NodeExtensionScope;
}

/**
 * Compiles every local subagent reachable from one parent node into a
 * flat node list, the parent→child edges that connect them, the remote
 * agents declared at this level, and the parent-scoped bindings their
 * config modules require.
 *
 * Recursive: each subagent may itself declare further subagents, which
 * are compiled depth-first via the injected `compileAgentNodeParts`
 * callback.
 */
export async function compileSubagentGraph(input: {
  readonly appRoot: string;
  readonly compileAgentNodeParts: CompileAgentNodePartsFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly parentAgentRoot: string;
  readonly parentNodeId: string;
  readonly subagents: readonly SubagentSelection[];
}): Promise<{
  readonly edges: readonly CompiledSubagentEdge[];
  readonly nodes: readonly CompiledSubagentNode[];
  readonly parentScopedBindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly remoteAgents: readonly CompiledRemoteAgentNode[];
}> {
  const compiledNodes: CompiledSubagentNode[] = [];
  const compiledEdges: CompiledSubagentEdge[] = [];
  const compiledRemoteAgents: CompiledRemoteAgentNode[] = [];
  const parentScopedBindings: Record<string, CompiledModuleBinding> = {};

  for (const selection of input.subagents) {
    const compiledSubagent = await compileSubagentDefinition({
      appRoot: input.appRoot,
      compileAgentNodeParts: input.compileAgentNodeParts,
      context: input.context,
      externalDependencies: input.externalDependencies,
      parentAgentRoot: input.parentAgentRoot,
      parentNodeId: input.parentNodeId,
      selection,
    });

    if (compiledSubagent.kind === "remote") {
      compiledRemoteAgents.push(compiledSubagent.node);
      parentScopedBindings[compiledSubagent.node.sourceId] = compiledSubagent.binding;
      continue;
    }

    compiledNodes.push(compiledSubagent.node, ...compiledSubagent.descendants.nodes);
    compiledEdges.push(
      {
        childNodeId: compiledSubagent.node.nodeId,
        parentNodeId: input.parentNodeId,
      },
      ...compiledSubagent.descendants.edges,
    );
  }

  return {
    edges: compiledEdges,
    nodes: compiledNodes,
    parentScopedBindings,
    remoteAgents: compiledRemoteAgents,
  };
}

async function compileSubagentDefinition(input: {
  readonly appRoot: string;
  readonly compileAgentNodeParts: CompileAgentNodePartsFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly parentAgentRoot: string;
  readonly parentNodeId: string;
  readonly selection: SubagentSelection;
}): Promise<
  | {
      readonly kind: "local";
      readonly descendants: {
        readonly edges: readonly CompiledSubagentEdge[];
        readonly nodes: readonly CompiledSubagentNode[];
      };
      readonly node: CompiledSubagentNode;
    }
  | {
      readonly binding: CompiledModuleBinding;
      readonly kind: "remote";
      readonly node: CompiledRemoteAgentNode;
    }
> {
  const source = input.selection.candidate.ref as LocalSubagentSourceRef;
  const scope = input.selection.nodeExtensionScope;
  const configModule = source.manifest.configModule;

  if (configModule === undefined) {
    throw new Error(`Subagent "${source.logicalPath}" is missing an agent config module.`);
  }

  const configModuleSource = createSubagentConfigModuleSourceRef({
    configModule,
    parentAgentRoot: input.parentAgentRoot,
    scope,
    source,
  });
  const configBacking: CompiledModuleBinding["backing"] = {
    externalDependencies: [...(input.externalDependencies ?? [])],
    kind: "filesystem",
    sourcePath: join(source.manifest.agentRoot, configModule.logicalPath),
    ...(scope === undefined
      ? {}
      : { extensionScope: { namespace: scope.namespace, sourceRoot: scope.sourceRoot } }),
  };
  const definition = await loadComposedModuleDefinition({
    backing: configBacking,
    displayPath: configModuleSource.logicalPath,
    exportName: configModule.exportName,
    extensionScopePackageNamespace: scope?.packageNamespace,
    externalDependencies: input.externalDependencies,
    kind: "subagent config",
    logicalPath: configModuleSource.logicalPath,
    registry: input.context.registry,
  });
  const dynamic = normalizeDynamicSubagentDefinition(
    definition,
    `Expected the dynamic subagent config export "${configModule.exportName ?? "default"}" from "${configModuleSource.logicalPath}" to match the public eve shape.`,
  );
  if (dynamic === undefined && readAgentDefinitionKind(definition) === "remote") {
    return {
      kind: "remote",
      binding: {
        backing: configBacking,
        logicalPath: configModuleSource.logicalPath,
        owner: input.selection.candidate.owner,
      },
      node: compileRemoteAgent({
        moduleSource: configModuleSource,
        source,
        value: definition,
      }),
    };
  }

  return {
    kind: "local",
    ...(await compileSubagent({
      ...input,
      agentConfigDefinition: dynamic === undefined ? definition : undefined,
      configDisplayPath: configModuleSource.logicalPath,
      configResolver:
        dynamic === undefined
          ? undefined
          : {
              ...configModule,
              sourceId: rewriteChildSourceId(configModule, scope),
              ...dynamic.definition,
              build: dynamic.build,
            },
      configResolverBacking: dynamic === undefined ? undefined : configBacking,
    })),
  };
}

async function compileSubagent(input: {
  readonly appRoot: string;
  readonly compileAgentNodeParts: CompileAgentNodePartsFn;
  readonly context: ManifestCompileContext;
  readonly agentConfigDefinition?: unknown;
  readonly configDisplayPath: string;
  readonly configResolver?: CompiledDynamicSubagentDefinition;
  readonly configResolverBacking?: CompiledModuleBinding["backing"];
  readonly externalDependencies?: readonly string[];
  readonly parentAgentRoot: string;
  readonly parentNodeId: string;
  readonly selection: SubagentSelection;
}): Promise<{
  readonly descendants: {
    readonly edges: readonly CompiledSubagentEdge[];
    readonly nodes: readonly CompiledSubagentNode[];
  };
  readonly node: CompiledSubagentNode;
}> {
  const source = input.selection.candidate.ref as LocalSubagentSourceRef;
  const scope = input.selection.nodeExtensionScope;
  const nodeId = createCompiledSubagentNodeId(input.parentNodeId, source.sourceId);
  const subagentName = source.subagentId;
  const sourceManifest = {
    ...source.manifest,
    appRoot: input.appRoot,
  };
  const inheritedExternalDependencies = mergeExternalDependencies(
    input.externalDependencies,
    input.configResolver?.build?.externalDependencies,
  );
  const nodeBase = {
    entryPath: source.entryPath,
    logicalPath: source.logicalPath,
    name: subagentName,
    nodeId,
    rootPath: source.rootPath,
    sourceId: source.sourceId,
    sourceKind: "module" as const,
  };

  if (input.configResolver === undefined) {
    const parts = await input.compileAgentNodeParts(sourceManifest, input.context, {
      agentConfigDefinition: input.agentConfigDefinition,
      allowRootOnlyConfig: false,
      configDisplayPath: input.configDisplayPath,
      externalDependencies: inheritedExternalDependencies,
      nodeExtensionScope: scope,
      nodeId,
    });
    const description = parts.config.description;
    if (!description) {
      throw new Error(
        `Local subagent "${source.logicalPath}" is missing a "description" field on its agent config. Add \`description\` to \`defineAgent({ ... })\` so the parent agent can decide when to delegate to this subagent.`,
      );
    }

    const descendants = await compileSubagentGraph({
      appRoot: input.appRoot,
      compileAgentNodeParts: input.compileAgentNodeParts,
      context: input.context,
      externalDependencies:
        parts.config.build?.externalDependencies ?? inheritedExternalDependencies,
      parentAgentRoot: source.manifest.agentRoot,
      parentNodeId: nodeId,
      subagents: parts.selectedSubagents,
    });
    return {
      descendants,
      node: {
        ...nodeBase,
        agent: assembleCompiledNodeManifest(parts, {
          parentScopedBindings: descendants.parentScopedBindings,
          remoteAgents: descendants.remoteAgents,
        }),
        description,
      },
    };
  }

  const parts = await input.compileAgentNodeParts(sourceManifest, input.context, {
    externalDependencies: inheritedExternalDependencies,
    mode: "resources",
    nodeExtensionScope: scope,
    nodeId,
  });
  const descendants = await compileSubagentGraph({
    appRoot: input.appRoot,
    compileAgentNodeParts: input.compileAgentNodeParts,
    context: input.context,
    externalDependencies: inheritedExternalDependencies,
    parentAgentRoot: source.manifest.agentRoot,
    parentNodeId: nodeId,
    subagents: parts.selectedSubagents,
  });
  const configResolverBinding: CompiledModuleBinding = {
    backing: input.configResolverBacking!,
    logicalPath: input.configResolver.logicalPath,
    owner: input.selection.candidate.owner,
  };
  return {
    descendants,
    node: {
      ...nodeBase,
      agent: createCompiledAgentResources({
        ...parts.resources,
        bindings: {
          ...parts.bindings,
          ...descendants.parentScopedBindings,
          [input.configResolver.sourceId]: configResolverBinding,
        },
        remoteAgents: descendants.remoteAgents,
        sourceComposition: parts.compositionState.toComposition(),
      }),
      configResolver: input.configResolver,
    },
  };
}

function compileRemoteAgent(input: {
  readonly moduleSource: {
    readonly exportName?: string;
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly sourceKind: "module";
  };
  readonly source: LocalSubagentSourceRef;
  readonly value: unknown;
}): CompiledRemoteAgentNode {
  assertRemoteAgentDefinitionHasNoLocalPackageEntries(input.source);

  const definition = normalizeRemoteAgentDefinition(
    input.value,
    `Expected the remote agent config export "${input.moduleSource.exportName ?? "default"}" from "${input.moduleSource.logicalPath}" to match the public eve shape.`,
  );
  const node = {
    ...input.moduleSource,
    description: definition.description,
    entryPath: input.source.entryPath,
    name: input.source.subagentId,
    nodeId: input.source.sourceId,
    outputSchema: definition.outputSchema,
    path: definition.path,
    rootPath: input.source.rootPath,
  };

  // A function `url` is deferred, so the compiled node omits it entirely.
  return definition.url === undefined ? node : { ...node, url: definition.url };
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
  if (!isDynamicSentinel(value)) {
    return undefined;
  }

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

  const normalized: {
    build?: { readonly externalDependencies?: readonly string[] };
    readonly definition: { readonly eventNames: readonly DynamicToolEventName[] };
  } = {
    definition: { eventNames },
  };
  if (build !== undefined) {
    normalized.build = build;
  }
  return normalized;
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

function mergeExternalDependencies(
  ...lists: ReadonlyArray<readonly string[] | undefined>
): readonly string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

function rewriteChildSourceId(
  ref: { readonly logicalPath: string; readonly sourceId: string },
  scope: NodeExtensionScope | undefined,
): string {
  const derived = createPathDerivedSourceId(ref.logicalPath);
  return scope === undefined ? derived : `ext:${scope.namespace}:${derived}`;
}

function createSubagentConfigModuleSourceRef(input: {
  readonly configModule: NonNullable<LocalSubagentSourceRef["manifest"]["configModule"]>;
  readonly parentAgentRoot: string;
  readonly scope: NodeExtensionScope | undefined;
  readonly source: LocalSubagentSourceRef;
}): {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
  readonly sourceKind: "module";
} {
  const logicalPath = relative(
    input.parentAgentRoot,
    join(input.source.manifest.agentRoot, input.configModule.logicalPath),
  ).replaceAll("\\", "/");
  const sourceId =
    input.scope === undefined
      ? createPathDerivedSourceId(logicalPath)
      : `ext:${input.scope.namespace}:${createPathDerivedSourceId(logicalPath)}`;
  const moduleSource: {
    exportName?: string;
    logicalPath: string;
    sourceId: string;
    sourceKind: "module";
  } = {
    logicalPath,
    sourceId,
    sourceKind: "module",
  };

  if (input.configModule.exportName !== undefined) {
    moduleSource.exportName = input.configModule.exportName;
  }

  return moduleSource;
}

function readAgentDefinitionKind(value: unknown): "local" | "remote" {
  if (value === null || typeof value !== "object") {
    return "local";
  }

  return (value as { readonly kind?: unknown }).kind === "remote" ? "remote" : "local";
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

  if (record.kind !== "remote") {
    throw new Error(`${message} Expected "kind" to be "remote".`);
  }

  // `forwardPrincipal` rides the module-backed runtime definition (like
  // `auth` and `headers`), so it is validated here but never baked into the
  // manifest.
  if (record.forwardPrincipal !== undefined) {
    expectBoolean(
      record.forwardPrincipal,
      `${message} Expected "forwardPrincipal" to be a boolean.`,
    );
  }

  return {
    description: expectString(record.description, message),
    outputSchema: serializeOutputSchema(record.outputSchema as ToolSchemaSource | undefined),
    path: record.path === undefined ? EVE_SESSION_ROUTE_PATH : expectString(record.path, message),
    // A function `url` is resolved at runtime, not baked into the manifest.
    url: typeof record.url === "function" ? undefined : expectString(record.url, message),
  };
}

function assertRemoteAgentDefinitionHasNoLocalPackageEntries(source: LocalSubagentSourceRef): void {
  const manifest = source.manifest;
  const extraEntries = [
    manifest.connections.length > 0 ? "connections/" : undefined,
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

  if (extraEntries.length === 0) {
    return;
  }

  throw new Error(
    `Remote subagent definition "${source.logicalPath}" cannot include local package entries. Remove unsupported entries: ${extraEntries.join(", ")}.`,
  );
}
