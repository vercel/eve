import type { ContextReader } from "#context/key.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import type {
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentDispatchRequest,
} from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import type { AgentInvocationRequest } from "#execution/tools/subagent/invoke-agent.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import {
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type DurableDynamicSubagentSelection,
} from "#context/keys.js";
import type { RuntimeSession } from "#subagents/start-outcome.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import {
  createRecursiveAgentRootOnlyResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import type { SubagentStartTarget } from "#execution/tools/subagent/start.js";
import type { SubagentInputSource } from "#subagents/tool.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.agent-invocation");

export type OwnerAgentDispatchPlanEntry =
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: SubagentStartTarget };

export function classifyFreshStart(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextReader;
  readonly session: RuntimeSession;
}): Extract<OwnerAgentDispatchPlanEntry, { kind: "reject" | "start" }> {
  const { action } = input;
  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const isDynamicSubagent =
    input.bundle.subagentRegistry.dynamicNodeIds?.has(action.nodeId) === true;
  const dynamicSubagentSelection = isDynamicSubagent
    ? getDynamicSubagentSelection(input.ctx, action.nodeId)
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
  if (isRecursiveAgentAction(action, registry) && input.session.rootSessionId !== undefined) {
    log.warn("recursive agent call blocked outside the root session", {
      callId: action.callId,
      nodeId: action.nodeId,
      rootSessionId: input.session.rootSessionId,
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
    description === undefined
      ? { outputSchema: input.bundle.turnAgent.outputSchema, type: "runtime" }
      : {
          description,
          outputSchema:
            dynamicAgentConfig?.outputSchema ??
            input.bundle.graph?.nodesByNodeId.get(action.nodeId)?.turnAgent?.outputSchema,
          type: "local",
        };
  return {
    kind: "start",
    target: { action, dynamicSubagentAgentConfig: dynamicAgentConfig, kind: "local", source },
  };
}

export function ownerPlanReusesSandbox(input: {
  readonly bundle: CompiledBundle;
  readonly plan: readonly (
    | OwnerAgentDispatchPlanEntry
    | { readonly kind: "resume"; readonly action: RuntimeAgentDispatchRequest }
  )[];
}): boolean {
  return input.plan.some((entry) => {
    if (entry.kind !== "start" || entry.target.kind !== "local") return false;
    const action = entry.target.action;
    const isSelfDelegation =
      action.subagentName === "agent" &&
      !input.bundle.subagentRegistry.subagentsByNodeId.has(action.nodeId);
    return (
      isSelfDelegation ||
      input.bundle.graph?.nodesByNodeId.get(action.nodeId)?.sandboxRegistry.sandbox.definition
        .kind === "parent"
    );
  });
}

function isRecursiveAgentAction(
  action: RuntimeAgentDispatchRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentDispatchRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === "agent" &&
    !subagentsByNodeId.has(action.nodeId)
  );
}

export function resolveAgentInvocationAction(input: {
  readonly ctx: ContextReader;
  readonly input: AgentInvocationRequest["input"];
  readonly invocationId: string;
}): RuntimeAgentDispatchRequest {
  const bundle = input.ctx.require(BundleKey);
  const registered = bundle.subagentRegistry.subagentsByName.get(input.input.target);
  const dynamicSelection =
    registered === undefined
      ? Object.values({
          ...input.ctx.get(SessionDynamicSubagentSelectionsKey),
          ...input.ctx.get(TurnDynamicSubagentSelectionsKey),
        }).find(
          (selection: DurableDynamicSubagentSelection) =>
            selection !== null && selection.prepared?.name === input.input.target,
        )
      : undefined;
  const definition =
    registered?.definition ??
    dynamicSelection?.prepared ??
    (input.input.target === AGENT_TOOL_NAME && bundle.nodeId === undefined
      ? {
          description: AGENT_TOOL_DESCRIPTION,
          kind: "subagent" as const,
          name: AGENT_TOOL_NAME,
          nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        }
      : undefined);
  if (definition === undefined) {
    throw new Error(`Agent target "${input.input.target}" is not available to this agent.`);
  }
  const actionInput: {
    agentId?: string;
    message: string;
    outputSchema?: JsonObject;
  } = { message: input.input.message };
  if (input.input.agentId !== undefined) actionInput.agentId = input.input.agentId;
  if (input.input.outputSchema !== undefined) actionInput.outputSchema = input.input.outputSchema;
  const common = {
    callId: input.invocationId,
    description: definition.description ?? "",
    input: actionInput,
    name: definition.name,
    nodeId: definition.nodeId,
  };
  return definition.kind === "remote"
    ? { ...common, kind: "remote-agent-call", remoteAgentName: definition.name }
    : { ...common, kind: "subagent-call", subagentName: definition.name };
}
