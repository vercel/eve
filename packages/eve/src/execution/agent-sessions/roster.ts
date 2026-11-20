import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { ownerReference } from "#execution/agent-sessions/owner.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import {
  type DynamicSubagentSelections,
  remoteAgentNames,
  resolveAgentAction,
  resolveAgentStartTarget,
  type AgentActionInput,
  type SubagentStartTarget,
} from "#execution/agent-sessions/target.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  InvalidRuntimeModelSelectionError,
  resolveRuntimeModelSelection,
} from "#runtime/agent/resolve-model.js";
import {
  type CompiledBundle,
  resolveSessionAgent,
} from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import { toErrorMessage } from "#shared/errors.js";
import { NonRetryableError } from "#shared/run-errors.js";
import type { SubagentSandboxGraph } from "#subagents/tool.js";
import type { AgentSessionModelSelection } from "#tools/workflow-definition.js";
import { readAgentToolModels } from "#tools/agent-models.js";
import { selectionModel } from "#models/options.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

export type LocalStartTarget = Extract<SubagentStartTarget, { readonly kind: "local" }>;

export interface AgentRoster {
  resolveAction(callId: string, input: AgentActionInput): RuntimeAgentDispatchRequest;
  remoteAgentNames(): readonly string[];
  startTarget(action: RuntimeAgentDispatchRequest, isRootSession: boolean): SubagentStartTarget;
  childRuntime(
    target: LocalStartTarget,
    overrides: AgentSessionRuntimeOverrides | undefined,
  ): SessionRuntimeConfig;
  runtimeOverrides(
    name: string,
    model: AgentSessionModelSelection,
    toolName?: string,
  ): Promise<AgentSessionRuntimeOverrides>;
  readonly graph?: SubagentSandboxGraph;
  readonly remote?: CompiledBundle["subagentRegistry"];
}

export async function loadAgentRoster(context: AgentSessionContext): Promise<AgentRoster> {
  return (await resolveSessionAgent(ownerReference(context))).roster(context.dynamicSelections);
}

export function compiledAgentRoster(
  bundle: CompiledBundle,
  dynamicSelections: DynamicSubagentSelections,
): AgentRoster {
  return {
    childRuntime: (target, overrides) => ({
      agentSessionRuntimeOverrides: overrides,
      compiledArtifactsSource: bundle.compiledArtifactsSource,
      dynamicSubagentAgentConfig: target.dynamicSubagentAgentConfig,
      nodeId: target.action.nodeId,
    }),
    graph: bundle.graph,
    remote: bundle.subagentRegistry,
    remoteAgentNames: () => remoteAgentNames(bundle, dynamicSelections),
    resolveAction: (callId, input) =>
      resolveAgentAction({ bundle, callId, dynamicSelections, input }),
    async runtimeOverrides(name, model, toolName) {
      const tool = await loadAgentModelsTool(bundle, toolName);
      if (tool !== undefined) {
        return { model: await resolveAgentToolModel(bundle, tool, model) };
      }
      try {
        const selection = await resolveRuntimeModelSelection({
          durability: "durable",
          modelMetadata: bundle.modelMetadata,
          selection: model,
        });
        return { model: selection.reference };
      } catch (error) {
        if (error instanceof InvalidRuntimeModelSelectionError) {
          throw new NonRetryableError(
            `ctx.agent("${name}", { model }) could not resolve the model selection: ${toErrorMessage(error)}`,
          );
        }
        throw error;
      }
    },
    startTarget: (action, isRootSession) =>
      resolveAgentStartTarget({ action, bundle, dynamicSelections, isRootSession }),
  };
}

interface AgentModelsTool {
  readonly definition: CompiledBundle["resolvedAgent"]["tools"][number];
  readonly models: NonNullable<ReturnType<typeof readAgentToolModels>>;
}

async function loadAgentModelsTool(
  bundle: CompiledBundle,
  toolName: string | undefined,
): Promise<AgentModelsTool | undefined> {
  const definition =
    toolName === undefined
      ? undefined
      : bundle.resolvedAgent.tools.find((candidate) => candidate.name === toolName);
  if (definition?.behavior?.handling?.kind !== "workflow-tool") return undefined;
  const models = readAgentToolModels(
    await loadResolvedModuleExport({
      definition,
      kindLabel: "tool",
      moduleMap: bundle.moduleMap,
      nodeId: bundle.nodeId,
    }),
  );
  return models === undefined ? undefined : { definition, models };
}

async function resolveAgentToolModel(
  bundle: CompiledBundle,
  { definition, models }: AgentModelsTool,
  model: AgentSessionModelSelection,
): Promise<RuntimeModelReference> {
  const option = typeof model === "string" ? models.get(model) : undefined;
  if (option === undefined) {
    throw new NonRetryableError(
      `The "${definition.name}" tool has no model ${JSON.stringify(model)}. Use one of its agent({ models }) keys, or omit model to use the current model.`,
    );
  }
  let reference: RuntimeModelReference;
  try {
    ({ reference } = await resolveRuntimeModelSelection({
      durability: "live",
      modelMetadata: bundle.modelMetadata,
      selection: option.selection,
    }));
  } catch (error) {
    if (error instanceof InvalidRuntimeModelSelectionError) {
      throw new NonRetryableError(
        `The "${definition.name}" tool could not resolve its model "${option.key}": ${toErrorMessage(error)}`,
      );
    }
    throw error;
  }
  if (typeof selectionModel(option.selection) === "string") return reference;
  return {
    ...reference,
    source: {
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      sourceId: definition.sourceId,
      sourceKind: "module",
    },
    sourceModelOption: option.key,
  };
}
