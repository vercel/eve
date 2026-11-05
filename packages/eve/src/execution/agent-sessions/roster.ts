import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { ownerReference } from "#execution/agent-sessions/owner.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import {
  type DynamicSubagentSelections,
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

// The agents a call's session can open, and where each runs: `SessionAgent.roster`. A compiled
// agent's is its bundle's subagent registry (here); another kind of agent brings its own.

/** A local child a roster resolved: where it starts, and the runtime its sessions run on. */
export type LocalStartTarget = Extract<SubagentStartTarget, { readonly kind: "local" }>;

/** The agents a session can delegate to, by the names its tools and `ctx.agent(name)` use. */
export interface AgentRoster {
  /** The dispatch request a call to `input.target` makes. Throws for a name it doesn't have. */
  resolveAction(callId: string, input: AgentActionInput): RuntimeAgentDispatchRequest;
  /** Where a fresh child for `action` starts. Throws when it can't start from this session. */
  startTarget(action: RuntimeAgentDispatchRequest, isRootSession: boolean): SubagentStartTarget;
  /** What the child's runtime runs, with `overrides` of its model. */
  childRuntime(
    target: LocalStartTarget,
    overrides: AgentSessionRuntimeOverrides | undefined,
  ): SessionRuntimeConfig;
  /**
   * `ctx.agent(name, { model })`'s model, as the child's overrides. `toolName` names the workflow
   * tool whose run opens the session, whose `agent({ models })` keys `model` may name.
   */
  runtimeOverrides(
    name: string,
    model: AgentSessionModelSelection,
    toolName?: string,
  ): Promise<AgentSessionRuntimeOverrides>;
  /** Which children share their parent's sandbox. Absent: only a copy of the parent does. */
  readonly graph?: SubagentSandboxGraph;
  /** The registry remote agents and their credentials resolve from: a compiled agent's only. */
  readonly remote?: CompiledBundle["subagentRegistry"];
}

/** The roster of the agent that owns `context`'s call. */
export async function loadAgentRoster(context: AgentSessionContext): Promise<AgentRoster> {
  return (await resolveSessionAgent(ownerReference(context))).roster(context.dynamicSelections);
}

/** A compiled agent's roster, with the dynamic agents the calling turn selected. */
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

/** The `agent({ models })` tool whose run opens the session, if that is what opens it. */
async function loadAgentModelsTool(
  bundle: CompiledBundle,
  toolName: string | undefined,
): Promise<AgentModelsTool | undefined> {
  const definition =
    toolName === undefined
      ? undefined
      : bundle.resolvedAgent.tools.find((candidate) => candidate.name === toolName);
  // Only a workflow tool's run opens sessions, and only `agent({ models })` carries models.
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

/**
 * An `agent({ models })` tool names its model by option key. A live model's reference points
 * back at the tool and key, so the child reads the model again from its own module map, and
 * replay opens the same option.
 */
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
