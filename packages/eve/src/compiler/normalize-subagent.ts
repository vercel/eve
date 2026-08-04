import {
  type AgentSourceManifest,
  createPathDerivedSourceId,
  type LocalSubagentSourceRef,
} from "#discover/manifest.js";
import {
  type CompiledAgentNodeManifest,
  type CompiledRemoteAgentNode,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  createCompiledSubagentNodeId,
} from "#compiler/manifest.js";
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
import { EVE_CREATE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { serializeOutputSchema, type ToolSchemaSource } from "#shared/tool-schema.js";
import type { JsonObject } from "#shared/json.js";
import { isDynamicSentinel, type DynamicToolEventName } from "#shared/dynamic-tool-definition.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";

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
    readonly allowWorkflowConfig?: boolean;
  },
) => Promise<CompiledAgentNodeManifest>;

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
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
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
      context: input.context,
      externalDependencies: input.externalDependencies,
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
  readonly context: ManifestCompileContext;
  readonly externalDependencies?: readonly string[];
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
  const definition = await loadModuleBackedDefinition({
    agentRoot: input.source.manifest.agentRoot,
    displayPath: configModuleSource.logicalPath,
    externalDependencies: input.externalDependencies,
    kind: "subagent config",
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
        source: input.source,
        value: definition,
      }),
    };
  }

  return {
    kind: "local",
    ...(await compileLocalSubagent({
      ...input,
      agentConfigDefinition:
        dynamic === undefined
          ? definition
          : {
              ...(dynamic.build === undefined ? {} : { build: dynamic.build }),
              model: DEFAULT_AGENT_MODEL_ID,
            },
      dynamic: dynamic?.definition,
    })),
  };
}

async function compileSubagent(input: {
  readonly appRoot: string;
  readonly compileAgentNodeManifest: CompileAgentNodeManifestFn;
  readonly context: ManifestCompileContext;
  readonly agentConfigDefinition?: unknown;
  readonly dynamic?: { readonly eventNames: readonly string[] };
  readonly externalDependencies?: readonly string[];
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
  const subagentName = input.source.subagentId;
  const agent = await input.compileAgentNodeManifest(
    {
      ...input.source.manifest,
      appRoot: input.appRoot,
    },
    input.context,
    {
      agentConfigDefinition: input.agentConfigDefinition,
      allowWorkflowConfig: false,
      externalDependencies: input.externalDependencies,
    },
  );

  const description = agent.config.description;

  let variant:
    | { readonly description: string; readonly dynamic?: never }
    | {
        readonly description?: never;
        readonly dynamic: { readonly eventNames: readonly string[] };
      };

  if (input.dynamic !== undefined) {
    variant = { dynamic: input.dynamic };
  } else {
    if (!description) {
      throw new Error(
        `Local subagent "${input.source.logicalPath}" is missing a "description" field on its agent config. Add \`description\` to \`defineAgent({ ... })\` so the parent agent can decide when to delegate to this subagent.`,
      );
    }
    variant = { description };
  }

  const descendants = await compileSubagentGraph({
    appRoot: input.appRoot,
    compileAgentNodeManifest: input.compileAgentNodeManifest,
    context: input.context,
    externalDependencies: agent.config.build?.externalDependencies,
    parentNodeId: nodeId,
    subagents: input.source.manifest.subagents,
  });
  return {
    descendants,
    node: {
      agent: {
        ...agent,
        remoteAgents: [...descendants.remoteAgents],
      },
      ...variant,
      entryPath: input.source.entryPath,
      logicalPath: input.source.logicalPath,
      name: subagentName,
      nodeId,
      rootPath: input.source.rootPath,
      sourceId: input.source.sourceId,
      sourceKind: "module",
    },
  };
}

const compileLocalSubagent = compileSubagent;

function compileRemoteAgent(input: {
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
  if (Object.hasOwn(record, "fallback")) {
    throw new Error(
      `${message} Dynamic subagent definitions do not support "fallback". Return defineAgent(...) or defineRemoteAgent(...) from an event handler instead.`,
    );
  }
  expectOnlyKnownKeys(record, ["build", "events", "kind"], message);

  const build =
    record.build === undefined
      ? undefined
      : normalizeAgentDefinition({ build: record.build, model: DEFAULT_AGENT_MODEL_ID }, message)
          .build;
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

  return {
    ...(build === undefined ? {} : { build }),
    definition: { eventNames },
  };
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
  const logicalPath =
    source.logicalPath === configModule.logicalPath
      ? configModule.logicalPath
      : `${source.logicalPath}/${configModule.logicalPath}`;
  const moduleSource: {
    exportName?: string;
    logicalPath: string;
    sourceId: string;
    sourceKind: "module";
  } = {
    logicalPath,
    sourceId: createPathDerivedSourceId(logicalPath),
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
    path:
      record.path === undefined
        ? EVE_CREATE_SESSION_ROUTE_PATH
        : expectString(record.path, message),
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
