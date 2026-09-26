import { FatalError } from "#compiled/@workflow/core/index.js";

import type { DurableDynamicSubagentSelection } from "#context/keys.js";
import {
  createRecursiveAgentRootOnlyResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import type { SubagentStartTarget } from "#execution/tools/subagent/start.js";
import { createLogger } from "#internal/logging.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentDispatchRequest,
} from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import type { SubagentInputSource } from "#subagents/tool.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";

const log = createLogger("execution.agent-target");

export type DynamicSubagentSelections = Readonly<Record<string, DurableDynamicSubagentSelection>>;

/** One message to an agent, addressed by its invocation name. */
export interface AgentActionInput {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
  readonly target: string;
}

export type AgentStartPlan =
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: SubagentStartTarget };

/**
 * Resolves an agent name against the calling agent's registry, its dynamic
 * selections, and the built-in root copy, as a dispatch request.
 */
export function resolveAgentAction(input: {
  readonly bundle: CompiledBundle;
  readonly callId: string;
  readonly dynamicSelections: DynamicSubagentSelections;
  readonly input: AgentActionInput;
}): RuntimeAgentDispatchRequest {
  const definition = findAgentDefinition(input.bundle, input.dynamicSelections, input.input.target);
  if (definition === undefined) {
    throw new FatalError(`Agent target "${input.input.target}" is not available to this agent.`);
  }
  const actionInput: {
    agentId?: string;
    message: string;
    outputSchema?: JsonObject;
  } = { message: input.input.message };
  if (input.input.agentId !== undefined) actionInput.agentId = input.input.agentId;
  if (input.input.outputSchema !== undefined) actionInput.outputSchema = input.input.outputSchema;
  const common = {
    callId: input.callId,
    description: definition.description ?? "",
    input: actionInput,
    name: definition.name,
    nodeId: definition.nodeId,
  };
  return definition.kind === "remote"
    ? { ...common, kind: "remote-agent-call", remoteAgentName: definition.name }
    : { ...common, kind: "subagent-call", subagentName: definition.name };
}

function findAgentDefinition(
  bundle: CompiledBundle,
  dynamicSelections: DynamicSubagentSelections,
  name: string,
) {
  const registered = bundle.subagentRegistry.subagentsByName.get(name);
  if (registered !== undefined) return registered.definition;
  const dynamic = Object.values(dynamicSelections).find(
    (selection) => selection !== null && selection.prepared.name === name,
  );
  if (dynamic != null) return dynamic.prepared;
  if (name === AGENT_TOOL_NAME && bundle.nodeId === undefined) {
    return {
      description: AGENT_TOOL_DESCRIPTION,
      kind: "subagent" as const,
      name: AGENT_TOOL_NAME,
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    };
  }
  return undefined;
}

/**
 * Plans a fresh child for a dispatch request, rejecting a dynamic agent whose
 * selection changed and a root copy outside the root session.
 */
export function resolveAgentStartTarget(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly dynamicSelections: DynamicSubagentSelections;
  readonly isRootSession: boolean;
}): AgentStartPlan {
  const { action } = input;
  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const isDynamicSubagent =
    input.bundle.subagentRegistry.dynamicNodeIds?.has(action.nodeId) === true;
  const dynamicSubagentSelection = isDynamicSubagent
    ? (input.dynamicSelections[action.nodeId] ?? undefined)
    : undefined;
  if (
    isDynamicSubagent &&
    (dynamicSubagentSelection === undefined ||
      (action.kind === "subagent-call" && dynamicSubagentSelection.kind !== "subagent") ||
      (action.kind === "remote-agent-call" && dynamicSubagentSelection.kind !== "remote"))
  ) {
    log.warn("dynamic subagent call blocked after availability changed", {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: getSubagentName(action),
    });
    return { kind: "reject", result: createUnavailableDynamicSubagentResult(action) };
  }
  if (isRecursiveAgentAction(action, registry) && !input.isRootSession) {
    log.warn("recursive agent call blocked outside the root session", {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    return { kind: "reject", result: createRecursiveAgentRootOnlyResult(action) };
  }
  if (action.kind === "remote-agent-call") {
    return {
      kind: "start",
      target: {
        action,
        dynamicRemoteAgent:
          dynamicSubagentSelection?.kind === "remote"
            ? dynamicSubagentSelection.remoteAgent
            : undefined,
        kind: "remote",
      },
    };
  }
  const dynamicAgentConfig =
    dynamicSubagentSelection?.kind === "subagent"
      ? dynamicSubagentSelection.agentConfig
      : undefined;
  const registered = registry.get(action.nodeId);
  const description =
    dynamicAgentConfig?.description ??
    (registered?.definition.kind === "subagent" ? registered.definition.description : undefined);
  const source: SubagentInputSource =
    description === undefined ? { type: "runtime" } : { description, type: "local" };
  return {
    kind: "start",
    target: { action, dynamicSubagentAgentConfig: dynamicAgentConfig, kind: "local", source },
  };
}

function isRecursiveAgentAction(
  action: RuntimeAgentDispatchRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentDispatchRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === AGENT_TOOL_NAME &&
    !subagentsByNodeId.has(action.nodeId)
  );
}
