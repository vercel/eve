import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  createCompiledAgentResources,
  type CompiledAgentManifest,
  type CompiledAgentDefinition,
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledChannelRoutePlan,
  type CompiledConnectionDefinition,
  type CompiledHookDefinition,
  type CompiledRemoteAgentNode,
  type CompiledSandboxDefinition,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  type CompiledToolDefinition,
  type CreateCompiledAgentManifestInput,
  type CreateCompiledAgentNodeManifestInput,
  type CreateCompiledAgentResourcesInput,
  type CreateCompiledAgentResourcesOptions,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import type { AgentSourceComposition } from "#compiler/source-composition.js";
import { canonicalAgentSourceSlot } from "#compiler/source-slot.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  getKernelCapabilityAtPath,
  getReplaceableKernelCapabilityAtRuntimeToolName,
  hasKernelCompiledRequirement,
  prepareKernelCapabilityPlan,
  type KernelCapabilityName,
} from "#kernel/capabilities.js";

export interface TestCompiledModuleBindingInput {
  readonly binding?: Omit<Partial<CompiledModuleBinding>, "logicalPath">;
  readonly logicalPath: string;
  readonly sourceId: string;
}

export const TEST_COMPILED_SANDBOX_SOURCE_ID = "test:stub-sandbox";
export const TEST_COMPILED_SANDBOX: CompiledSandboxDefinition = {
  hasBootstrap: false,
  hasOnSession: false,
  logicalPath: "sandbox.ts",
  sourceHash: "0".repeat(64),
  sourceId: TEST_COMPILED_SANDBOX_SOURCE_ID,
  sourceKind: "module",
};
export const TEST_COMPILED_SANDBOX_MODULE = Object.freeze({ default: () => ({}) });
export const TEST_COMPILED_AGENT_CONFIG_SOURCE_ID = "test:stub-agent-config";
export const TEST_COMPILED_AGENT_CONFIG_SOURCE: ModuleSourceRef = Object.freeze({
  logicalPath: "agent.ts",
  sourceId: TEST_COMPILED_AGENT_CONFIG_SOURCE_ID,
  sourceKind: "module",
});
export const TEST_COMPILED_AGENT_CONFIG_BINDING: TestCompiledModuleBindingInput = Object.freeze({
  logicalPath: TEST_COMPILED_AGENT_CONFIG_SOURCE.logicalPath,
  sourceId: TEST_COMPILED_AGENT_CONFIG_SOURCE.sourceId,
});
export const TEST_COMPILED_AGENT_CONFIG_MODULE = Object.freeze({
  default: Object.freeze({ model: "openai/gpt-5.5" }),
});
export const TEST_EMPTY_COMPILED_CHANNEL_ROUTE_PLAN: CompiledChannelRoutePlan = Object.freeze({
  effective: Object.freeze([]),
  preflight: Object.freeze([]),
  shadowed: Object.freeze([]),
});
export const TEST_COMPILED_WORKFLOW_WORLD = Object.freeze({
  kind: "native" as const,
  selection: "host-default" as const,
  target: "local" as const,
});

/** Creates a remote node with its config source owned by an independent graph scope. */
export function createTestCompiledRemoteAgentNode(
  input: Omit<CompiledRemoteAgentNode, "bindings" | "sourceComposition"> & {
    readonly configBinding?: CompiledModuleBinding;
  },
): CompiledRemoteAgentNode {
  const { configBinding, ...node } = input;
  return {
    ...node,
    bindings: {
      [node.configResolver.sourceId]: configBinding ?? {
        backing: node.backing,
        logicalPath: node.configResolver.logicalPath,
        owner: node.owner,
      },
    },
    sourceComposition: {
      disabled: [],
      selected: [
        {
          slot: canonicalAgentSourceSlot(node.configResolver.logicalPath),
          sourceId: node.configResolver.sourceId,
          sourceKind: "module",
        },
      ],
      shadowed: [],
    },
  };
}

export interface TestCompiledSubagentSourceInput {
  readonly backing?: CompiledModuleBinding["backing"];
  readonly logicalPath: string;
  readonly name: string;
  readonly owner?: CompiledModuleBinding["owner"];
  readonly sourceId: string;
}

interface TestCompositionInput {
  readonly subagentSources?: readonly TestCompiledSubagentSourceInput[];
}

type TestCompiledConnectionDefinitionInput = Omit<
  CompiledConnectionDefinition,
  "hasApproval" | "hasAuthorization" | "hasHeaders"
> &
  Partial<Pick<CompiledConnectionDefinition, "hasApproval" | "hasAuthorization" | "hasHeaders">>;

type TestCompiledHookDefinitionInput = Omit<CompiledHookDefinition, "eventNames"> &
  Partial<Pick<CompiledHookDefinition, "eventNames">>;

type TestCompiledSandboxDefinitionInput = Omit<
  CompiledSandboxDefinition,
  "hasBootstrap" | "hasOnSession"
> &
  Partial<Pick<CompiledSandboxDefinition, "hasBootstrap" | "hasOnSession">>;

type TestCompiledToolDefinitionInput = Omit<
  CompiledToolDefinition,
  "hasAuth" | "hasExecute" | "hasModelOutputProjection" | "requiresApproval"
> &
  Partial<
    Pick<
      CompiledToolDefinition,
      "hasAuth" | "hasExecute" | "hasModelOutputProjection" | "requiresApproval"
    >
  >;

interface TestCompiledResourceDefinitionInputs {
  readonly connections?: readonly TestCompiledConnectionDefinitionInput[];
  readonly hooks?: readonly TestCompiledHookDefinitionInput[];
  readonly instrumentation?: CreateCompiledAgentResourcesInput["instrumentation"];
  readonly sandbox?: TestCompiledSandboxDefinitionInput;
  readonly tools?: readonly TestCompiledToolDefinitionInput[];
}

type PreparedTestCompiledResources<T> = Omit<
  T,
  | "bindings"
  | "channelRoutes"
  | "connections"
  | "hooks"
  | "instrumentation"
  | "kernelPlan"
  | "sandbox"
  | "tools"
> & {
  readonly bindings: readonly TestCompiledModuleBindingInput[];
  readonly channelRoutes: CompiledChannelRoutePlan;
  readonly connections: readonly CompiledConnectionDefinition[];
  readonly hooks: readonly CompiledHookDefinition[];
  readonly instrumentation: CreateCompiledAgentResourcesInput["instrumentation"];
  readonly kernelPlan: CreateCompiledAgentResourcesInput["kernelPlan"];
  readonly sandbox: CompiledSandboxDefinition;
  readonly tools: readonly CompiledToolDefinition[];
};

export type CreateTestCompiledAgentResourcesInput = Omit<
  CreateCompiledAgentResourcesInput,
  | "bindings"
  | "channelRoutes"
  | "connections"
  | "hooks"
  | "instrumentation"
  | "kernelPlan"
  | "sandbox"
  | "sourceComposition"
  | "tools"
> & {
  readonly bindings: readonly TestCompiledModuleBindingInput[];
  readonly channelRoutes?: CompiledChannelRoutePlan;
  readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
} & TestCompiledResourceDefinitionInputs &
  TestCompositionInput;

export type CreateStubCompiledAgentNodeManifestInput = Omit<
  CreateCompiledAgentNodeManifestInput,
  | "bindings"
  | "channelRoutes"
  | "config"
  | "connections"
  | "hooks"
  | "instrumentation"
  | "kernelPlan"
  | "sandbox"
  | "sourceComposition"
  | "tools"
> & {
  readonly bindings: readonly TestCompiledModuleBindingInput[];
  readonly channelRoutes?: CompiledChannelRoutePlan;
  readonly config: TestCompiledAgentDefinition;
  readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
} & TestCompiledResourceDefinitionInputs &
  TestCompositionInput;

export type CreateStubCompiledAgentManifestInput = Omit<
  CreateCompiledAgentManifestInput,
  | "bindings"
  | "channelRoutes"
  | "config"
  | "connections"
  | "externalDependencyPlan"
  | "hooks"
  | "instrumentation"
  | "kernelPlan"
  | "sandbox"
  | "sourceComposition"
  | "tools"
  | "workflowWorld"
> & {
  readonly bindings: readonly TestCompiledModuleBindingInput[];
  readonly channelRoutes?: CompiledChannelRoutePlan;
  readonly config: TestCompiledAgentDefinition;
  readonly externalDependencyPlan?: CreateCompiledAgentManifestInput["externalDependencyPlan"];
  readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
  readonly workflowWorld?: CreateCompiledAgentManifestInput["workflowWorld"];
} & TestCompiledResourceDefinitionInputs &
  TestCompositionInput;

export type TestCompiledAgentDefinition = CompiledAgentDefinition extends infer TConfig
  ? TConfig extends CompiledAgentDefinition
    ? Omit<TConfig, "source"> & { readonly source: ModuleSourceRef }
    : never
  : never;

/** Creates an explicit binding table for hand-built compiled test artifacts. */
export function createTestCompiledModuleBindings(
  entries: readonly TestCompiledModuleBindingInput[],
): Record<string, CompiledModuleBinding> {
  const bindings: Record<string, CompiledModuleBinding> = {};

  for (const entry of entries) {
    if (bindings[entry.sourceId] !== undefined) {
      throw new Error(`Duplicate test compiled binding for "${entry.sourceId}".`);
    }
    bindings[entry.sourceId] = {
      backing: entry.binding?.backing ?? {
        kind: "programmatic",
        moduleId: entry.sourceId,
        registryId: "test-compiled-manifest",
        revision: "test-compiled-manifest-v1",
      },
      logicalPath: entry.logicalPath,
      owner: entry.binding?.owner ?? { kind: "application" },
    };
  }

  return bindings;
}

/** Builds the complete test composition from explicit bindings and non-module records. */
export function createTestAgentSourceComposition(input: {
  readonly bindings: readonly TestCompiledModuleBindingInput[];
  readonly instructions?: CreateCompiledAgentResourcesInput["instructions"];
  readonly schedules?: CreateCompiledAgentResourcesInput["schedules"];
  readonly skills?: CreateCompiledAgentResourcesInput["skills"];
  readonly sandboxWorkspaces?: CreateCompiledAgentResourcesInput["sandboxWorkspaces"];
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly subagentEdges?: readonly CompiledSubagentEdge[];
  readonly subagentSources?: readonly TestCompiledSubagentSourceInput[];
  readonly subagents?: readonly CompiledSubagentNode[];
}): AgentSourceComposition {
  const selected: AgentSourceComposition["selected"][number][] = input.bindings.map((entry) => ({
    slot: canonicalAgentSourceSlot(entry.logicalPath),
    sourceId: entry.sourceId,
    sourceKind: "module",
  }));

  for (const source of [
    ...(input.instructions ?? []),
    ...(input.schedules ?? []),
    ...(input.skills ?? []),
  ]) {
    if (source.sourceKind === "module") continue;
    selected.push({
      slot: canonicalAgentSourceSlot(source.logicalPath),
      source: {
        layer: "application",
        logicalPath: source.logicalPath,
        owner: { kind: "application" },
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
      },
      sourceKind: "non-module",
    });
  }

  for (const source of input.sandboxWorkspaces ?? []) {
    selected.push({
      slot: canonicalAgentSourceSlot(source.logicalPath),
      source: {
        layer: "application",
        logicalPath: source.logicalPath,
        owner: { kind: "application" },
        sourceId: source.sourceId,
        sourceKind: "workspace",
      },
      sourceKind: "non-module",
    });
  }

  for (const source of readTestDirectSubagentSources(input)) {
    const owner = source.owner ?? ({ kind: "application" } as const);
    const layer =
      owner.kind === "framework"
        ? "framework-default"
        : owner.kind === "extension"
          ? "extension-package"
          : "application";
    selected.push({
      slot: `subagents/${source.name}`,
      source: {
        backing: source.backing ?? {
          kind: "programmatic",
          moduleId: source.sourceId,
          registryId: "test-compiled-manifest",
          revision: "test-compiled-manifest-v1",
        },
        layer,
        logicalPath: source.logicalPath,
        owner,
        sourceId: source.sourceId,
        sourceKind: "subagent",
      },
      sourceKind: "non-module",
    });
  }

  return { disabled: [], selected, shadowed: [] };
}

function readTestDirectSubagentSources(input: {
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly subagentEdges?: readonly CompiledSubagentEdge[];
  readonly subagentSources?: readonly TestCompiledSubagentSourceInput[];
  readonly subagents?: readonly CompiledSubagentNode[];
}): readonly TestCompiledSubagentSourceInput[] {
  const directChildNodeIds = new Set(
    (input.subagentEdges ?? [])
      .filter((edge) => edge.parentNodeId === ROOT_COMPILED_AGENT_NODE_ID)
      .map((edge) => edge.childNodeId),
  );
  return [
    ...(input.subagents ?? [])
      .filter(
        (source) => input.subagentEdges === undefined || directChildNodeIds.has(source.nodeId),
      )
      .map((source) => ({
        backing: source.backing,
        logicalPath: source.logicalPath,
        name: source.name,
        owner: source.owner,
        sourceId: source.sourceId,
      })),
    ...(input.remoteAgents ?? []).map((source) => ({
      backing: source.backing,
      logicalPath: source.logicalPath,
      name: source.name,
      owner: source.owner,
      sourceId: source.sourceId,
    })),
    ...(input.subagentSources ?? []),
  ];
}

function toTestKernelSemanticSubagentSources(
  sources: readonly TestCompiledSubagentSourceInput[],
): NonNullable<CreateCompiledAgentResourcesOptions["subagentSources"]> {
  return sources.map((source) => ({
    backing: source.backing ?? {
      kind: "programmatic",
      moduleId: source.sourceId,
      registryId: "test-compiled-manifest",
      revision: "test-compiled-manifest-v1",
    },
    logicalPath: source.logicalPath,
    name: source.name,
    owner: source.owner ?? { kind: "application" },
    sourceId: source.sourceId,
  }));
}

/** Test-only wrapper that keeps the production constructor contract intact. */
export function createTestCompiledAgentResources(
  input: CreateTestCompiledAgentResourcesInput,
  options: CreateCompiledAgentResourcesOptions,
): CompiledAgentResources {
  const prepared = prepareTestCompiledResources(input, false, false);
  return createCompiledAgentResources(
    {
      ...prepared,
      bindings: createTestCompiledModuleBindings(prepared.bindings),
      sourceComposition: createTestAgentSourceComposition(prepared),
    },
    {
      ...options,
      subagentSources: toTestKernelSemanticSubagentSources(readTestDirectSubagentSources(prepared)),
    },
  );
}

/** Test-only wrapper that keeps the production node constructor contract intact. */
export function createStubCompiledAgentNodeManifest(
  input: CreateStubCompiledAgentNodeManifestInput,
  options: Pick<CreateCompiledAgentResourcesOptions, "isRoot" | "nodeId">,
): CompiledAgentNodeManifest {
  const prepared = prepareTestCompiledAgentNode(input, false);
  return createCompiledAgentNodeManifest(
    {
      ...prepared,
      bindings: createTestCompiledModuleBindings(prepared.bindings),
      sourceComposition: createTestAgentSourceComposition(prepared),
    },
    {
      ...options,
      subagentSources: toTestKernelSemanticSubagentSources(readTestDirectSubagentSources(prepared)),
    },
  );
}

/** Test-only wrapper that keeps the production root constructor contract intact. */
export function createStubCompiledAgentManifest(
  input: CreateStubCompiledAgentManifestInput,
): CompiledAgentManifest {
  const prepared = prepareTestCompiledAgentNode(input, true);
  return createCompiledAgentManifest({
    ...prepared,
    bindings: createTestCompiledModuleBindings(prepared.bindings),
    externalDependencyPlan: input.externalDependencyPlan ?? { entries: [] },
    sourceComposition: createTestAgentSourceComposition(prepared),
    workflowWorld: input.workflowWorld ?? TEST_COMPILED_WORKFLOW_WORLD,
  });
}

function prepareTestCompiledAgentNode<
  T extends TestCompiledResourceDefinitionInputs & {
    readonly bindings: readonly TestCompiledModuleBindingInput[];
    readonly channelRoutes?: CompiledChannelRoutePlan;
    readonly config: TestCompiledAgentDefinition;
    readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
  },
>(
  input: T,
  isRoot: boolean,
): Omit<PreparedTestCompiledResources<T>, "config"> & {
  readonly config: CompiledAgentDefinition;
} {
  const prepared = prepareTestCompiledResources(
    input,
    isRoot,
    input.config.experimental?.tasks === true,
  );
  const source = input.config.source;
  const configBinding = prepared.bindings.find((entry) => entry.sourceId === source.sourceId);
  if (configBinding === undefined) {
    throw new Error(
      `Test compiled agent config source "${source.sourceId}" requires an explicit binding.`,
    );
  }
  if (configBinding.logicalPath !== source.logicalPath) {
    throw new Error(
      `Test compiled agent config source "${source.sourceId}" uses logical path "${source.logicalPath}", but its binding uses "${configBinding.logicalPath}".`,
    );
  }
  const { config: _config, ...resources } = prepared;
  return {
    ...resources,
    config: input.config as CompiledAgentDefinition,
  } as Omit<PreparedTestCompiledResources<T>, "config"> & {
    readonly config: CompiledAgentDefinition;
  };
}

function prepareTestCompiledResources<
  T extends TestCompiledResourceDefinitionInputs & {
    readonly bindings: readonly TestCompiledModuleBindingInput[];
    readonly channelRoutes?: CompiledChannelRoutePlan;
    readonly dynamicSkills?: CreateCompiledAgentResourcesInput["dynamicSkills"];
    readonly dynamicTools?: CreateCompiledAgentResourcesInput["dynamicTools"];
    readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
    readonly skills?: CreateCompiledAgentResourcesInput["skills"];
    readonly subagentSources?: readonly TestCompiledSubagentSourceInput[];
    readonly subagents?: readonly CompiledSubagentNode[];
    readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
    readonly webSearchProvider?: CreateCompiledAgentResourcesInput["webSearchProvider"];
    readonly workflowTool?: CreateCompiledAgentResourcesInput["workflowTool"];
  },
>(input: T, isRoot: boolean, tasksEnabled: boolean): PreparedTestCompiledResources<T> {
  const sandbox: CompiledSandboxDefinition = {
    ...(input.sandbox ?? TEST_COMPILED_SANDBOX),
    hasBootstrap: input.sandbox?.hasBootstrap ?? false,
    hasOnSession: input.sandbox?.hasOnSession ?? false,
  };
  let bindings = input.bindings.some((entry) => entry.sourceId === sandbox.sourceId)
    ? input.bindings
    : [
        ...input.bindings,
        {
          logicalPath: sandbox.logicalPath,
          sourceId: sandbox.sourceId,
        },
      ];
  bindings = ensureTestKernelSpecialSource(bindings, input);
  const replaced = new Set<KernelCapabilityName>();
  let frameworkLoadSkill = false;
  for (const entry of bindings) {
    const capability = getKernelCapabilityAtPath(entry.logicalPath);
    if (capability === undefined) continue;
    const ordinary =
      input.tools?.some((tool) => tool.sourceId === entry.sourceId) === true ||
      input.dynamicTools?.some((tool) => tool.sourceId === entry.sourceId) === true;
    if (!ordinary) continue;
    if (
      entry.binding?.owner?.kind === "framework" &&
      hasKernelCompiledRequirement(capability, "canonical-framework-tool")
    ) {
      frameworkLoadSkill = true;
    } else if (entry.binding?.owner?.kind !== "framework") {
      replaced.add(capability);
    }
  }
  for (const { name } of readTestDirectSubagentSources(input)) {
    const replacement = getReplaceableKernelCapabilityAtRuntimeToolName(name);
    if (replacement !== undefined) replaced.add(replacement);
  }
  return {
    ...input,
    bindings,
    channelRoutes: input.channelRoutes ?? TEST_EMPTY_COMPILED_CHANNEL_ROUTE_PLAN,
    connections: (input.connections ?? []).map((connection) => ({
      ...connection,
      hasApproval: connection.hasApproval ?? false,
      hasAuthorization: connection.hasAuthorization ?? false,
      hasHeaders: connection.hasHeaders ?? false,
    })),
    hooks: (input.hooks ?? []).map((hook) => ({
      ...hook,
      eventNames: [...(hook.eventNames ?? [])],
    })),
    instrumentation: input.instrumentation ?? { kind: "none" },
    kernelPlan: prepareKernelCapabilityPlan({
      disabled: new Set(),
      frameworkLoadSkill,
      hasSkills: (input.skills?.length ?? 0) > 0 || (input.dynamicSkills?.length ?? 0) > 0,
      isRoot,
      replaced,
      tasksEnabled,
      webSearch: input.webSearchProvider !== undefined,
      workflow: input.workflowTool !== undefined,
    }),
    sandbox,
    tools: (input.tools ?? []).map((tool) => ({
      ...tool,
      hasAuth: tool.hasAuth ?? false,
      hasExecute: tool.hasExecute ?? true,
      hasModelOutputProjection: tool.hasModelOutputProjection ?? false,
      requiresApproval: tool.requiresApproval ?? false,
    })),
  };
}

function ensureTestKernelSpecialSource<
  T extends {
    readonly webSearchProvider?: CreateCompiledAgentResourcesInput["webSearchProvider"];
    readonly workflowTool?: CreateCompiledAgentResourcesInput["workflowTool"];
  },
>(
  input: readonly TestCompiledModuleBindingInput[],
  resources: T,
): readonly TestCompiledModuleBindingInput[] {
  const bindings = [...input];
  if (
    resources.webSearchProvider !== undefined &&
    !bindings.some((entry) => entry.sourceId === resources.webSearchProvider?.sourceId)
  ) {
    bindings.push({
      binding: {
        backing: {
          kind: "programmatic",
          moduleId: "test:kernel-web-search",
          registryId: "test-compiled-manifest",
          revision: "test-compiled-manifest-v1",
        },
        owner: { kind: "application" },
      },
      logicalPath: resources.webSearchProvider.logicalPath,
      sourceId: resources.webSearchProvider.sourceId,
    });
  }
  if (
    resources.workflowTool !== undefined &&
    !bindings.some((entry) => entry.sourceId === resources.workflowTool?.sourceId)
  ) {
    bindings.push({
      logicalPath: resources.workflowTool.logicalPath,
      sourceId: resources.workflowTool.sourceId,
    });
  }
  return bindings;
}
