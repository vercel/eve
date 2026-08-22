import { join } from "node:path";

import { type AgentSourceManifest, type LocalSubagentSourceRef } from "#discover/manifest.js";
import {
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledRemoteAgentNode,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  createCompiledSubagentNodeId,
} from "#compiler/manifest.js";
import {
  getSubagentSourceOrigin,
  type AgentSourceOrigin,
} from "#compiler/compose-agent-sources.js";
import type { CompiledDynamicSubagentDefinition } from "#compiler/remote-agent-node.js";
import {
  loadModuleBackedDefinition,
  type ManifestCompileContext,
} from "#compiler/normalize-helpers.js";
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
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { isDynamicSentinel, type DynamicToolEventName } from "#shared/dynamic-tool-definition.js";
import { createFilesystemModuleBindings } from "#compiler/module-binding.js";

const ALLOWED_DYNAMIC_SUBAGENT_EVENTS = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
]);

/**
 * Callback the subagent compiler uses to recurse into the per-node
 * manifest compiler. Injected by `normalize-manifest.ts` so this module
 * does not have to import the orchestrator (which would create a
 * circular dependency).
 */
export type CompileAgentNodeManifestFn = (
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options?: {
    readonly agentConfigDefinition?: unknown;
    readonly externalDependencies?: readonly string[];
    readonly allowRootOnlyConfig?: boolean;
    readonly nodeId?: string;
    readonly sourceOrigin?: AgentSourceOrigin;
    readonly sourcesComposed?: boolean;
  },
) => Promise<CompiledAgentNodeManifest>;

export type CompileAgentResourcesFn = (
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options?: {
    readonly externalDependencies?: readonly string[];
    readonly nodeId?: string;
    readonly sourceOrigin?: AgentSourceOrigin;
    readonly sourcesComposed?: boolean;
  },
) => Promise<CompiledAgentResources>;

/**
 * Compiles every local subagent reachable from one parent node into a
 * flat node list and the parent→child edges that connect them.
 *
 * Recursive: each subagent may itself declare further subagents, which
 * are compiled depth-first via the injected `compileAgentNodeManifest`
 * callback.
 */
export async function compileSubagentGraph(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly parentAgentRoot: string;
  readonly parentNodeId: string;
  readonly subagents: readonly LocalSubagentSourceRef[];
}): Promise<{
  readonly edges: readonly CompiledSubagentEdge[];
  readonly nodes: readonly CompiledSubagentNode[];
  readonly remoteAgents: readonly CompiledRemoteAgentNode[];
}> {
  const compiledNodes: CompiledSubagentNode[] = [];
  const compiledEdges: CompiledSubagentEdge[] = [];
  const compiledRemoteAgents: CompiledRemoteAgentNode[] = [];

  for (const subagentSource of input.subagents) {
    const compiledSubagent = await compileSubagentDefinition({
      appRoot: input.appRoot,
      compileAgentNodeManifest: input.compileAgentNodeManifest,
      compileAgentResources: input.compileAgentResources,
      context: input.context,
      externalDependencies: input.externalDependencies,
      parentAgentRoot: input.parentAgentRoot,
      parentNodeId: input.parentNodeId,
      source: subagentSource,
    });

    if (compiledSubagent.kind === "remote") {
      compiledRemoteAgents.push(compiledSubagent.node);
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
    remoteAgents: compiledRemoteAgents,
  };
}

async function compileSubagentDefinition(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
  readonly parentAgentRoot: string;
  readonly parentNodeId: string;
  readonly source: LocalSubagentSourceRef;
}): Promise<
  | {
      readonly kind: "local";
      readonly descendants: {
        readonly edges: readonly CompiledSubagentEdge[];
        readonly nodes: readonly CompiledSubagentNode[];
        readonly remoteAgents: readonly CompiledRemoteAgentNode[];
      };
      readonly node: CompiledSubagentNode;
    }
  | {
      readonly kind: "remote";
      readonly node: CompiledRemoteAgentNode;
    }
> {
  const configModule = input.source.manifest.configModule;

  if (configModule === undefined) {
    throw new Error(`Subagent "${input.source.logicalPath}" is missing an agent config module.`);
  }

  const configModuleSource = createSubagentConfigModuleSourceRef(input.source, configModule);
  const sourceOrigin = getSubagentSourceOrigin(input.source);
  const definition = await loadModuleBackedDefinition({
    agentRoot: input.source.manifest.agentRoot,
    binding:
      input.context.bindingsByAgentRoot.get(input.source.manifest.agentRoot)?.[
        configModule.sourceId
      ] ??
      (sourceOrigin === undefined
        ? undefined
        : {
            backing: {
              ...sourceOrigin.backing,
              sourcePath: join(input.source.manifest.agentRoot, configModule.logicalPath),
            },
            logicalPath: configModule.logicalPath,
            owner: sourceOrigin.owner,
          }),
    displayPath: configModuleSource.logicalPath,
    externalDependencies: input.externalDependencies,
    kind: "subagent config",
    moduleLoader: input.context.moduleLoader,
    source: configModule,
  });
  const dynamic = normalizeDynamicSubagentDefinition(
    definition,
    `Expected the dynamic subagent config export "${configModule.exportName ?? "default"}" from "${configModuleSource.logicalPath}" to match the public eve shape.`,
  );
  if (dynamic === undefined && readAgentDefinitionKind(definition) === "remote") {
    return {
      kind: "remote",
      node: compileRemoteAgent({
        parentAgentRoot: input.parentAgentRoot,
        source: input.source,
        value: definition,
      }),
    };
  }

  return {
    kind: "local",
    ...(await compileLocalSubagent({
      ...input,
      agentConfigDefinition: dynamic === undefined ? definition : undefined,
      configResolver:
        dynamic === undefined
          ? undefined
          : { ...configModule, ...dynamic.definition, build: dynamic.build },
    })),
  };
}

async function compileSubagent(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly compileAgentResources: CompileAgentResourcesFn;
  readonly context: ManifestCompileContext;
  readonly agentConfigDefinition?: unknown;
  readonly configResolver?: CompiledDynamicSubagentDefinition;
  readonly externalDependencies?: readonly string[];
  readonly parentAgentRoot: string;
  readonly parentNodeId: string;
  readonly source: LocalSubagentSourceRef;
}): Promise<{
  readonly descendants: {
    readonly edges: readonly CompiledSubagentEdge[];
    readonly nodes: readonly CompiledSubagentNode[];
    readonly remoteAgents: readonly CompiledRemoteAgentNode[];
  };
  readonly node: CompiledSubagentNode;
}> {
  const nodeId = createCompiledSubagentNodeId(input.parentNodeId, input.source.sourceId);
  const sourceOrigin = getSubagentSourceOrigin(input.source);
  const subagentName = input.source.subagentId;
  const sourceManifest = {
    ...input.source.manifest,
    appRoot: input.appRoot,
  };
  const inheritedExternalDependencies = mergeExternalDependencies(
    input.externalDependencies,
    input.configResolver?.build?.externalDependencies,
  );
  const nodeBase = {
    entryPath: input.source.entryPath,
    logicalPath: input.source.logicalPath,
    name: subagentName,
    nodeId,
    rootPath: input.source.rootPath,
    sourceId: input.source.sourceId,
    sourceKind: "module" as const,
  };

  if (input.configResolver === undefined) {
    const agent = await input.compileAgentNodeManifest(sourceManifest, input.context, {
      agentConfigDefinition: input.agentConfigDefinition,
      allowRootOnlyConfig: false,
      externalDependencies: inheritedExternalDependencies,
      nodeId,
      sourceOrigin,
    });
    const description = agent.config.description;
    if (!description) {
      throw new Error(
        `Local subagent "${input.source.logicalPath}" is missing a "description" field on its agent config. Add \`description\` to \`defineAgent({ ... })\` so the parent agent can decide when to delegate to this subagent.`,
      );
    }

    const descendants = await compileSubagentGraph({
      appRoot: input.appRoot,
      compileAgentNodeManifest: input.compileAgentNodeManifest,
      context: input.context,
      compileAgentResources: input.compileAgentResources,
      externalDependencies:
        agent.config.build?.externalDependencies ?? inheritedExternalDependencies,
      parentAgentRoot: input.source.manifest.agentRoot,
      parentNodeId: nodeId,
      subagents: input.context.manifestsByNodeId.get(nodeId)?.subagents ?? sourceManifest.subagents,
    });
    const compiledAgent = { ...agent, remoteAgents: [...descendants.remoteAgents] };
    return {
      descendants,
      node: {
        ...nodeBase,
        agent: {
          ...compiledAgent,
          bindings: createSubagentNodeBindings({
            agent: compiledAgent,
            context: input.context,
            externalDependencies: compiledAgent.config.build?.externalDependencies,
          }),
        },
        description,
      },
    };
  }

  const resources = await input.compileAgentResources(sourceManifest, input.context, {
    externalDependencies: inheritedExternalDependencies,
    nodeId,
    sourceOrigin,
  });
  const descendants = await compileSubagentGraph({
    appRoot: input.appRoot,
    compileAgentNodeManifest: input.compileAgentNodeManifest,
    context: input.context,
    compileAgentResources: input.compileAgentResources,
    externalDependencies: inheritedExternalDependencies,
    parentAgentRoot: input.source.manifest.agentRoot,
    parentNodeId: nodeId,
    subagents: input.context.manifestsByNodeId.get(nodeId)?.subagents ?? sourceManifest.subagents,
  });
  const compiledResources = { ...resources, remoteAgents: [...descendants.remoteAgents] };
  return {
    descendants,
    node: {
      ...nodeBase,
      agent: {
        ...compiledResources,
        bindings: createSubagentNodeBindings({
          additionalRefs: [input.configResolver],
          agent: compiledResources,
          context: input.context,
          externalDependencies: inheritedExternalDependencies,
        }),
      },
      configResolver: input.configResolver,
    },
  };
}

const compileLocalSubagent = compileSubagent;

function createSubagentNodeBindings(input: {
  readonly additionalRefs?: readonly ModuleSourceRef[];
  readonly agent: CompiledAgentNodeManifest | CompiledAgentResources;
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
}): CompiledAgentResources["bindings"] {
  const bindings = createFilesystemModuleBindings({
    additionalRefs: input.additionalRefs,
    agentRoot: input.agent.agentRoot,
    externalDependencies: input.externalDependencies,
    manifest: input.agent,
  });
  const composedBindings = input.context.bindingsByAgentRoot.get(input.agent.agentRoot) ?? {};
  for (const sourceId of Object.keys(bindings)) {
    if (composedBindings[sourceId] !== undefined) {
      bindings[sourceId] = composedBindings[sourceId];
    }
  }
  return { ...bindings, ...input.agent.bindings };
}

function compileRemoteAgent(input: {
  readonly parentAgentRoot: string;
  readonly source: LocalSubagentSourceRef;
  readonly value: unknown;
}): CompiledRemoteAgentNode {
  const configModule = input.source.manifest.configModule;

  if (configModule === undefined) {
    throw new Error(`Remote agent "${input.source.logicalPath}" is missing a config module.`);
  }

  assertRemoteAgentDefinitionHasNoLocalPackageEntries(input.source);

  const moduleSource = createSubagentConfigModuleSourceRef(input.source, configModule);
  const definition = normalizeRemoteAgentDefinition(
    input.value,
    `Expected the remote agent config export "${configModule.exportName ?? "default"}" from "${moduleSource.logicalPath}" to match the public eve shape.`,
  );
  const node = {
    ...moduleSource,
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

function createSubagentConfigModuleSourceRef(
  source: LocalSubagentSourceRef,
  configModule: NonNullable<LocalSubagentSourceRef["manifest"]["configModule"]>,
): {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
  readonly sourceKind: "module";
} {
  const logicalPath = source.logicalPath;
  const moduleSource: {
    exportName?: string;
    logicalPath: string;
    sourceId: string;
    sourceKind: "module";
  } = {
    logicalPath,
    sourceId: source.sourceId,
    sourceKind: "module",
  };

  if (configModule.exportName !== undefined) {
    moduleSource.exportName = configModule.exportName;
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
