import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { RuntimeActionRequest } from "#shared/runtime-actions.js";

/** The closed set of model-visible capabilities owned by eve's native kernel. */
export const KERNEL_CAPABILITY_NAMES = [
  "agent",
  "task_cancel",
  "task_update",
  "ask_question",
  "load_skill",
  "web_search",
  "Workflow",
  "final_output",
] as const;

export type KernelCapabilityName = (typeof KERNEL_CAPABILITY_NAMES)[number];
export type KernelCapabilityScope = "node" | "session" | "turn" | "model";
export type KernelCapabilityCompiledRequirement =
  | "canonical-framework-tool"
  | "skills"
  | "web-search-provider"
  | "workflow-config";
export type KernelSpecialDefinitionKind = "web-search-tool" | "workflow-tool";
export type KernelPromptFeature =
  | "subagents-available"
  | "task-update-guidance"
  | "tools-available";

export interface KernelCapabilityPreparationInput {
  readonly disabled: ReadonlySet<KernelCapabilityName>;
  readonly frameworkLoadSkill: boolean;
  readonly hasSkills: boolean;
  readonly isRoot: boolean;
  readonly replaced: ReadonlySet<KernelCapabilityName>;
  readonly tasksEnabled: boolean;
  readonly webSearch: boolean;
  readonly workflow: boolean;
}

/** Per-call facts used to narrow compiled potential to actually advertised work. */
export interface KernelCapabilityAdvertisementInput {
  readonly delegatedCaller?: boolean;
  readonly modelSupportsProviderTools?: boolean;
  readonly requestInput?: boolean;
  readonly rootSession: boolean;
  readonly structuredOutput?: boolean;
  readonly subagentDepth: number;
}

export interface KernelNodeMaterializationInput<T> {
  readonly agent: (name: "agent") => T;
  readonly askQuestion: (name: "ask_question") => T;
  readonly taskCancel: (name: "task_cancel") => T;
  readonly taskUpdate: (name: "task_update") => T;
  readonly webSearch: (name: "web_search") => T;
}

export interface KernelProviderInstallDecision<T> {
  readonly handled: boolean;
  readonly tool?: T;
}

export interface KernelRuntimeCallClassificationInput {
  readonly definition: HarnessToolDefinition;
  readonly resolveInput: (
    value: unknown,
    context: { readonly callId: string; readonly toolName: string },
  ) => JsonObject;
  readonly toolCall: {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  };
}

export interface KernelTaskControlOperations<T> {
  readonly cancel: () => Promise<T>;
  readonly update: () => Promise<T>;
}

export type KernelCapabilityInspectionProjection =
  | {
      readonly kind: "framework-source";
      readonly canonicalPath: `tools/${string}.ts`;
      readonly name: KernelCapabilityName;
    }
  | {
      readonly description: string;
      readonly hasAuth: boolean;
      readonly kind: "native";
      readonly canonicalPath: `tools/${string}.ts`;
      readonly hasExecute: boolean;
      readonly hasModelOutputProjection: boolean;
      readonly hasOutputSchema: boolean;
      readonly inputSchema: null;
      readonly name: KernelCapabilityName;
      readonly outputSchema: null;
      readonly requiresApproval: boolean;
      readonly sourceKind: "kernel";
    };

type KernelNativeInspectionDetails = Omit<
  Extract<KernelCapabilityInspectionProjection, { kind: "native" }>,
  "canonicalPath" | "name"
>;

type KernelCapabilityInspectionDetails =
  | { readonly kind: "framework-source" }
  | KernelNativeInspectionDetails;

export interface KernelCapabilityStrategy<Name extends KernelCapabilityName> {
  readonly actionEmissionExclusion: () => Name | undefined;
  readonly acceptsSpecialDefinition: (kind: KernelSpecialDefinitionKind) => boolean;
  readonly advertisement: (input: KernelCapabilityAdvertisementInput) => boolean;
  readonly canonicalPath: `tools/${string}.ts`;
  readonly classifyRuntimeCall: (
    input: KernelRuntimeCallClassificationInput,
  ) => RuntimeActionRequest | undefined;
  readonly compiledRequirements: readonly KernelCapabilityCompiledRequirement[];
  readonly dispatchTaskControl: <T>(
    operations: KernelTaskControlOperations<T>,
  ) => Promise<T> | undefined;
  readonly extractTerminalOutput: (
    input: {
      readonly calls: readonly {
        readonly input: unknown;
        readonly invalid: boolean;
        readonly toolName: string;
      }[];
    },
    name: Name,
  ) => JsonValue | undefined;
  readonly inspection: () => KernelCapabilityInspectionDetails;
  readonly installProviderTool: <T>(input: {
    readonly installWebSearch: () => Promise<T>;
    readonly modelSupportsProviderTools: boolean;
  }) => Promise<KernelProviderInstallDecision<T>>;
  readonly installTurnTool: <T>(
    input: {
      readonly installFinalOutput: (name: "final_output") => T;
      readonly structuredOutput: boolean;
    },
    name: Name,
  ) => T | undefined;
  readonly materializeNodeTool: <T>(
    input: KernelNodeMaterializationInput<T>,
    name: Name,
  ) => T | undefined;
  readonly name: Name;
  readonly preparation: (input: KernelCapabilityPreparationInput) => boolean;
  readonly promptFeatures: (
    input: KernelCapabilityAdvertisementInput | undefined,
  ) => readonly KernelPromptFeature[];
  readonly recoversUnsupportedProviderType: (upstreamType: string) => boolean;
  readonly grantsTaskUpdateAuthority: (taskOwned: boolean) => boolean;
  readonly replacement: "authored-source" | "reserved";
  readonly reserveAcrossTaskTargets: () => Name | undefined;
  readonly scope: KernelCapabilityScope;
  readonly selectsInputRequest: boolean;
  readonly selectsTaskControl: boolean;
  readonly selectsTerminalOutput: boolean;
  readonly useWorkflow: <T>(operation: () => T) => T | undefined;
}

const advertiseAtRoot = (input: KernelCapabilityAdvertisementInput): boolean =>
  input.rootSession && input.subagentDepth === 0;
const noActionEmissionExclusion = (): undefined => undefined;
const noSpecialDefinition = (): boolean => false;
const noRuntimeCall = (): undefined => undefined;
const noTaskControl = <T>(): Promise<T> | undefined => undefined;
const noTerminalOutput = (): undefined => undefined;
const noTaskUpdateAuthority = (): boolean => false;
const noProviderTool = async <T>(): Promise<KernelProviderInstallDecision<T>> => ({
  handled: false,
});
const noProviderToolRecovery = (): boolean => false;
const noTurnTool = <T>(): T | undefined => undefined;
const noNodeTool = <T>(): T | undefined => undefined;
const noTaskTargetReservation = (): undefined => undefined;
const noWorkflow = <T>(): T | undefined => undefined;
const nativeInspection = (hasExecute: boolean): KernelNativeInspectionDetails => ({
  description: "",
  hasAuth: false,
  hasExecute,
  hasModelOutputProjection: false,
  hasOutputSchema: false,
  inputSchema: null,
  kind: "native",
  outputSchema: null,
  requiresApproval: false,
  sourceKind: "kernel",
});

/**
 * The sole executable lifecycle inventory for native model-visible work.
 * Every literal name must implement every stage, including explicit no-ops.
 */
const KERNEL_CAPABILITIES = {
  agent: {
    actionEmissionExclusion: noActionEmissionExclusion,
    acceptsSpecialDefinition: noSpecialDefinition,
    advertisement: advertiseAtRoot,
    canonicalPath: "tools/agent.ts",
    classifyRuntimeCall: ({ definition, resolveInput, toolCall }) => {
      if (definition.runtimeAction?.kind !== "subagent-call") return undefined;
      return {
        callId: toolCall.toolCallId,
        description: definition.description,
        input: resolveInput(toolCall.input, {
          callId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        }),
        kind: "subagent-call",
        name: definition.name,
        nodeId: definition.runtimeAction.nodeId,
        subagentName: definition.runtimeAction.subagentName,
      };
    },
    compiledRequirements: [],
    dispatchTaskControl: noTaskControl,
    extractTerminalOutput: noTerminalOutput,
    inspection: () => nativeInspection(true),
    installProviderTool: noProviderTool,
    installTurnTool: noTurnTool,
    materializeNodeTool: (input, name) => input.agent(name),
    name: "agent",
    preparation: (input) => input.isRoot,
    promptFeatures: () => ["subagents-available", "tools-available"],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "authored-source",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "session",
    selectsInputRequest: false,
    selectsTaskControl: false,
    selectsTerminalOutput: false,
    useWorkflow: noWorkflow,
  },
  task_cancel: {
    actionEmissionExclusion: noActionEmissionExclusion,
    acceptsSpecialDefinition: noSpecialDefinition,
    advertisement: advertiseAtRoot,
    canonicalPath: "tools/task_cancel.ts",
    classifyRuntimeCall: noRuntimeCall,
    compiledRequirements: [],
    dispatchTaskControl: (operations) => operations.cancel(),
    extractTerminalOutput: noTerminalOutput,
    inspection: () => nativeInspection(true),
    installProviderTool: noProviderTool,
    installTurnTool: noTurnTool,
    materializeNodeTool: (input, name) => input.taskCancel(name),
    name: "task_cancel",
    preparation: (input) => input.isRoot && input.tasksEnabled,
    promptFeatures: () => ["tools-available"],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "authored-source",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "session",
    selectsInputRequest: false,
    selectsTaskControl: true,
    selectsTerminalOutput: false,
    useWorkflow: noWorkflow,
  },
  task_update: {
    actionEmissionExclusion: noActionEmissionExclusion,
    acceptsSpecialDefinition: noSpecialDefinition,
    advertisement: (input) => input.delegatedCaller === true,
    canonicalPath: "tools/task_update.ts",
    classifyRuntimeCall: noRuntimeCall,
    compiledRequirements: [],
    dispatchTaskControl: (operations) => operations.update(),
    extractTerminalOutput: noTerminalOutput,
    inspection: () => nativeInspection(true),
    installProviderTool: noProviderTool,
    installTurnTool: noTurnTool,
    materializeNodeTool: (input, name) => input.taskUpdate(name),
    name: "task_update",
    preparation: (input) => input.isRoot && input.tasksEnabled,
    promptFeatures: () => ["task-update-guidance", "tools-available"],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: (taskOwned) => taskOwned,
    replacement: "authored-source",
    reserveAcrossTaskTargets: () => "task_update",
    scope: "session",
    selectsInputRequest: false,
    selectsTaskControl: true,
    selectsTerminalOutput: false,
    useWorkflow: noWorkflow,
  },
  ask_question: {
    actionEmissionExclusion: () => "ask_question",
    acceptsSpecialDefinition: noSpecialDefinition,
    advertisement: (input) => input.requestInput === true,
    canonicalPath: "tools/ask_question.ts",
    classifyRuntimeCall: noRuntimeCall,
    compiledRequirements: [],
    dispatchTaskControl: noTaskControl,
    extractTerminalOutput: noTerminalOutput,
    inspection: () => nativeInspection(false),
    installProviderTool: noProviderTool,
    installTurnTool: noTurnTool,
    materializeNodeTool: (input, name) => input.askQuestion(name),
    name: "ask_question",
    preparation: () => true,
    promptFeatures: () => ["tools-available"],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "authored-source",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "session",
    selectsInputRequest: true,
    selectsTaskControl: false,
    selectsTerminalOutput: false,
    useWorkflow: noWorkflow,
  },
  load_skill: {
    actionEmissionExclusion: noActionEmissionExclusion,
    acceptsSpecialDefinition: noSpecialDefinition,
    advertisement: () => true,
    canonicalPath: "tools/load_skill.ts",
    classifyRuntimeCall: ({ resolveInput, toolCall }) => ({
      callId: toolCall.toolCallId,
      input: resolveInput(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }),
      kind: "load-skill",
    }),
    compiledRequirements: ["canonical-framework-tool", "skills"],
    dispatchTaskControl: noTaskControl,
    extractTerminalOutput: noTerminalOutput,
    inspection: () => ({ kind: "framework-source" }),
    installProviderTool: noProviderTool,
    installTurnTool: noTurnTool,
    materializeNodeTool: noNodeTool,
    name: "load_skill",
    preparation: (input) => input.frameworkLoadSkill && input.hasSkills,
    promptFeatures: () => ["tools-available"],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "authored-source",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "node",
    selectsInputRequest: false,
    selectsTaskControl: false,
    selectsTerminalOutput: false,
    useWorkflow: noWorkflow,
  },
  web_search: {
    actionEmissionExclusion: noActionEmissionExclusion,
    acceptsSpecialDefinition: (kind) => kind === "web-search-tool",
    advertisement: (input) => input.modelSupportsProviderTools === true,
    canonicalPath: "tools/web_search.ts",
    classifyRuntimeCall: noRuntimeCall,
    compiledRequirements: ["web-search-provider"],
    dispatchTaskControl: noTaskControl,
    extractTerminalOutput: noTerminalOutput,
    inspection: () => nativeInspection(false),
    installProviderTool: async (input) => ({
      handled: true,
      tool: input.modelSupportsProviderTools ? await input.installWebSearch() : undefined,
    }),
    installTurnTool: noTurnTool,
    materializeNodeTool: (input, name) => input.webSearch(name),
    name: "web_search",
    preparation: (input) => input.webSearch,
    promptFeatures: () => ["tools-available"],
    recoversUnsupportedProviderType: (upstreamType) => upstreamType === "web_search_20250305",
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "authored-source",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "model",
    selectsInputRequest: false,
    selectsTaskControl: false,
    selectsTerminalOutput: false,
    useWorkflow: noWorkflow,
  },
  Workflow: {
    actionEmissionExclusion: noActionEmissionExclusion,
    acceptsSpecialDefinition: (kind) => kind === "workflow-tool",
    advertisement: advertiseAtRoot,
    canonicalPath: "tools/workflow.ts",
    classifyRuntimeCall: noRuntimeCall,
    compiledRequirements: ["workflow-config"],
    dispatchTaskControl: noTaskControl,
    extractTerminalOutput: noTerminalOutput,
    inspection: () => nativeInspection(false),
    installProviderTool: noProviderTool,
    installTurnTool: noTurnTool,
    materializeNodeTool: noNodeTool,
    name: "Workflow",
    preparation: (input) => input.workflow,
    promptFeatures: () => ["tools-available"],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "authored-source",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "session",
    selectsInputRequest: false,
    selectsTaskControl: false,
    selectsTerminalOutput: false,
    useWorkflow: (operation) => operation(),
  },
  final_output: {
    actionEmissionExclusion: () => "final_output",
    acceptsSpecialDefinition: noSpecialDefinition,
    advertisement: (input) => input.structuredOutput === true,
    canonicalPath: "tools/final_output.ts",
    classifyRuntimeCall: noRuntimeCall,
    compiledRequirements: [],
    dispatchTaskControl: noTaskControl,
    extractTerminalOutput: ({ calls }, name) =>
      calls.find((call) => call.toolName === name && !call.invalid)?.input as JsonValue | undefined,
    inspection: () => nativeInspection(false),
    installProviderTool: noProviderTool,
    installTurnTool: (input, name) =>
      input.structuredOutput ? input.installFinalOutput(name) : undefined,
    materializeNodeTool: noNodeTool,
    name: "final_output",
    preparation: () => true,
    promptFeatures: () => [],
    recoversUnsupportedProviderType: noProviderToolRecovery,
    grantsTaskUpdateAuthority: noTaskUpdateAuthority,
    replacement: "reserved",
    reserveAcrossTaskTargets: noTaskTargetReservation,
    scope: "turn",
    selectsInputRequest: false,
    selectsTaskControl: false,
    selectsTerminalOutput: true,
    useWorkflow: noWorkflow,
  },
} as const satisfies {
  readonly [Name in KernelCapabilityName]: KernelCapabilityStrategy<Name>;
};

/** Serializable compiler authority for native work that may be used by a node. */
export interface KernelCapabilityPlan {
  readonly prepared: readonly KernelCapabilityName[];
}

export interface SessionKernelCapabilityResolution {
  readonly plan: KernelCapabilityPlan;
  readonly taskControl: { readonly taskUpdate: boolean };
}

const KERNEL_CAPABILITY_NAMES_SET: ReadonlySet<string> = new Set(KERNEL_CAPABILITY_NAMES);
const RESERVED_KERNEL_CAPABILITY_NAMES: readonly KernelCapabilityName[] =
  KERNEL_CAPABILITY_NAMES.filter((name) => KERNEL_CAPABILITIES[name].replacement === "reserved");
const KERNEL_CAPABILITIES_BY_PATH: ReadonlyMap<string, KernelCapabilityName> = new Map(
  KERNEL_CAPABILITY_NAMES.map(
    (name) => [stripLogicalPathExtension(KERNEL_CAPABILITIES[name].canonicalPath), name] as const,
  ),
);
const REPLACEABLE_KERNEL_CAPABILITIES_BY_PATH: ReadonlyMap<string, KernelCapabilityName> = new Map(
  KERNEL_CAPABILITY_NAMES.filter(
    (name) => KERNEL_CAPABILITIES[name].replacement === "authored-source",
  ).map(
    (name) => [stripLogicalPathExtension(KERNEL_CAPABILITIES[name].canonicalPath), name] as const,
  ),
);

export function isKernelCapabilityName(value: string): value is KernelCapabilityName {
  return KERNEL_CAPABILITY_NAMES_SET.has(value);
}

function readOwnedKernelCapabilityStrategy(
  name: KernelCapabilityName,
): KernelCapabilityStrategy<KernelCapabilityName> {
  return KERNEL_CAPABILITIES[name] as KernelCapabilityStrategy<KernelCapabilityName>;
}

export function getExecutableKernelCapabilityStrategy(
  name: KernelCapabilityName,
): KernelCapabilityStrategy<KernelCapabilityName> {
  return readOwnedKernelCapabilityStrategy(name);
}

/** Resolves rejected provider types against capabilities installed for one call. */
export function resolveRejectedKernelProviderCapabilities(
  installed: ReadonlySet<KernelCapabilityName>,
  upstreamTypes: readonly string[],
): KernelCapabilityName[] {
  return KERNEL_CAPABILITY_NAMES.filter(
    (name) =>
      installed.has(name) &&
      upstreamTypes.some((type) =>
        readOwnedKernelCapabilityStrategy(name).recoversUnsupportedProviderType(type),
      ),
  );
}

export function getReplaceableKernelCapabilityAtPath(
  logicalPath: string,
): KernelCapabilityName | undefined {
  return REPLACEABLE_KERNEL_CAPABILITIES_BY_PATH.get(stripLogicalPathExtension(logicalPath));
}

export function getReplaceableKernelCapabilityAtRuntimeToolName(
  toolName: string,
): KernelCapabilityName | undefined {
  if (!isKernelCapabilityName(toolName)) return undefined;
  return KERNEL_CAPABILITIES[toolName].replacement === "authored-source" ? toolName : undefined;
}

export function getKernelCapabilityAtPath(logicalPath: string): KernelCapabilityName | undefined {
  return KERNEL_CAPABILITIES_BY_PATH.get(stripLogicalPathExtension(logicalPath));
}

export function isReservedKernelCapability(name: KernelCapabilityName): boolean {
  return KERNEL_CAPABILITIES[name].replacement === "reserved";
}

export function getKernelCapabilityCanonicalPath(name: KernelCapabilityName): `tools/${string}.ts` {
  return KERNEL_CAPABILITIES[name].canonicalPath;
}

export function getKernelCompiledRequirements(
  name: KernelCapabilityName,
): readonly KernelCapabilityCompiledRequirement[] {
  return readOwnedKernelCapabilityStrategy(name).compiledRequirements;
}

export function hasKernelCompiledRequirement(
  name: KernelCapabilityName,
  requirement: KernelCapabilityCompiledRequirement,
): boolean {
  return readOwnedKernelCapabilityStrategy(name).compiledRequirements.includes(requirement);
}

export function isKernelSpecialDefinitionPath(
  logicalPath: string,
  kind: KernelSpecialDefinitionKind,
): boolean {
  const name = getKernelCapabilityAtPath(logicalPath);
  return name !== undefined && KERNEL_CAPABILITIES[name].acceptsSpecialDefinition(kind);
}

export function isKernelFrameworkSourceCapability(name: KernelCapabilityName): boolean {
  return KERNEL_CAPABILITIES[name].inspection().kind === "framework-source";
}

export function createKernelCapabilityPlan(
  prepared: readonly KernelCapabilityName[],
): KernelCapabilityPlan {
  return { prepared: [...prepared] };
}

/** Resolves session-only authority without mutating a child node's compiled plan. */
export function resolveSessionKernelPlan(input: {
  readonly nodePlan: KernelCapabilityPlan;
  readonly rootPlan: KernelCapabilityPlan;
  readonly taskOwned: boolean;
}): SessionKernelCapabilityResolution {
  const taskUpdateName = input.rootPlan.prepared.find((name) =>
    KERNEL_CAPABILITIES[name].grantsTaskUpdateAuthority(input.taskOwned),
  );
  const taskUpdate = taskUpdateName !== undefined;
  return {
    plan:
      taskUpdateName !== undefined && !hasPreparedKernelCapability(input.nodePlan, taskUpdateName)
        ? createKernelCapabilityPlan(
            KERNEL_CAPABILITY_NAMES.filter(
              (name) => name === taskUpdateName || input.nodePlan.prepared.includes(name),
            ),
          )
        : input.nodePlan,
    taskControl: { taskUpdate },
  };
}

export function prepareKernelCapabilityPlan(
  input: KernelCapabilityPreparationInput,
): KernelCapabilityPlan {
  return createKernelCapabilityPlan(
    KERNEL_CAPABILITY_NAMES.filter((name) => {
      const strategy = readOwnedKernelCapabilityStrategy(name);
      if (strategy.replacement === "authored-source" && input.replaced.has(name)) return false;
      if (input.disabled.has(name)) return false;
      return strategy.preparation(input);
    }),
  );
}

export function hasPreparedKernelCapability(
  plan: KernelCapabilityPlan,
  name: KernelCapabilityName,
): boolean {
  return plan.prepared.includes(name);
}

export function isKernelCapabilityAdvertised(
  plan: KernelCapabilityPlan,
  name: KernelCapabilityName,
  input: KernelCapabilityAdvertisementInput,
): boolean {
  return hasPreparedKernelCapability(plan, name) && KERNEL_CAPABILITIES[name].advertisement(input);
}

/** Resolves prompt features from capabilities actually available to this session/model call. */
export function getAdvertisedKernelPromptFeatures(
  plan: KernelCapabilityPlan,
  input: KernelCapabilityAdvertisementInput,
  options: { readonly excludedScopes?: ReadonlySet<KernelCapabilityScope> } = {},
): ReadonlySet<KernelPromptFeature> {
  return new Set(
    plan.prepared.flatMap((name) => {
      const strategy = readOwnedKernelCapabilityStrategy(name);
      return options.excludedScopes?.has(strategy.scope) !== true && strategy.advertisement(input)
        ? strategy.promptFeatures(input)
        : [];
    }),
  );
}

/** Resolves prompt features owned by one executable lifecycle scope. */
export function getAdvertisedKernelPromptFeaturesAtScope(
  plan: KernelCapabilityPlan,
  input: KernelCapabilityAdvertisementInput,
  scope: KernelCapabilityScope,
  excludedCapabilities?: ReadonlySet<KernelCapabilityName>,
): ReadonlySet<KernelPromptFeature> {
  return new Set(
    plan.prepared.flatMap((name) => {
      const strategy = readOwnedKernelCapabilityStrategy(name);
      return strategy.scope === scope &&
        excludedCapabilities?.has(name) !== true &&
        strategy.advertisement(input)
        ? strategy.promptFeatures(input)
        : [];
    }),
  );
}

export function getKernelReservedToolNames(plan: KernelCapabilityPlan): ReadonlySet<string> {
  return new Set([...plan.prepared, ...RESERVED_KERNEL_CAPABILITY_NAMES]);
}

export function getPreparedKernelTaskTargetReservations(
  plan: KernelCapabilityPlan,
): ReadonlySet<string> {
  return new Set(
    plan.prepared.flatMap((name) => {
      const reserved = readOwnedKernelCapabilityStrategy(name).reserveAcrossTaskTargets();
      return reserved === undefined ? [] : [reserved];
    }),
  );
}

export function getReservedKernelCapabilityNames(): readonly KernelCapabilityName[] {
  return RESERVED_KERNEL_CAPABILITY_NAMES;
}

export function isKernelInputRequestToolName(toolName: string): boolean {
  return KERNEL_CAPABILITY_NAMES.some((name) => {
    const strategy = readOwnedKernelCapabilityStrategy(name);
    return strategy.selectsInputRequest && strategy.name === toolName;
  });
}

export function projectPreparedKernelCapabilitiesForInspection(plan: KernelCapabilityPlan): {
  readonly frameworkSourcePaths: ReadonlySet<string>;
  readonly native: readonly Extract<KernelCapabilityInspectionProjection, { kind: "native" }>[];
} {
  const frameworkSourcePaths = new Set<string>();
  const native: Extract<KernelCapabilityInspectionProjection, { kind: "native" }>[] = [];
  for (const name of plan.prepared) {
    const strategy = KERNEL_CAPABILITIES[name];
    const details = strategy.inspection();
    if (details.kind === "framework-source") {
      frameworkSourcePaths.add(strategy.canonicalPath);
    } else {
      native.push({
        ...details,
        canonicalPath: strategy.canonicalPath,
        name: strategy.name,
      });
    }
  }
  return { frameworkSourcePaths, native };
}
