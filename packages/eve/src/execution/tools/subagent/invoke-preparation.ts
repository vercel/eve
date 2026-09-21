import type { ContextReader } from "#context/key.js";
import { deserializeContext } from "#context/serialize.js";
import {
  prepareActionDispatch,
  type PreparedCoordinationDispatch,
} from "#execution/coordination-dispatch-shared.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
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
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import {
  isAgentHandleAction,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#subagents/handle-dispatch.js";
import { getAgentRegistryState, type AgentRegistryEntry } from "#subagents/registry/state.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import {
  createRecursiveAgentRootOnlyResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import type { SubagentStartTarget } from "#execution/tools/subagent/start.js";
import type { SubagentInputSource } from "#subagents/tool.js";
import { createLogger } from "#internal/logging.js";
import { findBackgroundWorkflowToolRun } from "#harness/workflow-tool-runs.js";

const log = createLogger("execution.agent-invocation");

export type OwnerAgentDispatchPlanEntry =
  | {
      readonly kind: "resume";
      readonly action: RuntimeAgentHandleAction;
      readonly agentId: string;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    }
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: SubagentStartTarget };

/** Prepares one workflow-owner agent invocation from durable inputs. */
export async function prepareOwnerAgentInvocation(input: {
  readonly invocation: AgentInvocationRequest["input"];
  readonly invocationId: string;
  readonly knownAgentIds?: readonly string[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId?: string;
}): Promise<Omit<PreparedCoordinationDispatch<OwnerAgentDispatchPlanEntry>, "sessionState">> {
  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const event = getHarnessEmissionState(durableSession.state);
  const task =
    input.taskId === undefined
      ? undefined
      : findBackgroundWorkflowToolRun(durableSession.state, input.taskId);
  const action = resolveAgentInvocationAction({
    ctx,
    input: input.invocation,
    invocationId: input.invocationId,
    handles: getAgentRegistryState(durableSession.state)?.handles,
    allowUnregistered: task !== undefined,
  });
  return await prepareActionDispatch({
    batch: {
      requests: [action],
      event: {
        ...event,
        stepIndex: task?.origin.stepIndex ?? event.stepIndex,
        turnId: task?.origin.turnId ?? activeTurnId(event),
      },
    },
    ctx,
    durableSession,
    fanoutSize: 1,
    plan: ({ bundle, ctx: planContext, session }) => [
      planAgentDispatch({
        action,
        bundle,
        ctx: planContext,
        knownAgentIds: input.knownAgentIds,
        session,
      }),
    ],
    planSharesSandbox: ({ bundle, plan }) => ownerPlanSharesSandbox({ bundle, plan }),
    serializedContext: input.serializedContext,
  });
}

export function planAgentDispatch(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextReader;
  readonly knownAgentIds?: readonly string[];
  readonly session: RuntimeSession;
}): OwnerAgentDispatchPlanEntry {
  const knownAgentIds = new Set(
    input.knownAgentIds ??
      (getAgentRegistryState(input.session.state)?.handles ?? []).map(
        (handle) => handle.identity.id,
      ),
  );
  const rawAgentId = input.action.input.agentId;
  const agentId =
    typeof rawAgentId === "string" && rawAgentId.trim() !== "" ? rawAgentId : undefined;
  if (agentId !== undefined && isAgentHandleAction(input.action)) {
    const handle = getAgentRegistryState(input.session.state)?.handles.find(
      (entry) => entry.identity.id === agentId,
    );
    if (handle?.phase === "registered" || handle?.phase === "reserved")
      return classifyFreshStart(input);
    if (knownAgentIds.has(agentId)) {
      const dynamicSubagentSelection =
        input.bundle.subagentRegistry.dynamicNodeIds?.has(input.action.nodeId) === true
          ? getDynamicSubagentSelection(input.ctx, input.action.nodeId)
          : undefined;
      const registeredRemote = handle?.identity.registration?.target;
      return {
        action: input.action,
        agentId,
        dynamicRemoteAgent:
          registeredRemote?.kind === "remote"
            ? {
                description: handle!.identity.registration!.description,
                path: EVE_SESSION_ROUTE_PATH,
                url: registeredRemote.url,
                publicUrl: true,
              }
            : input.action.kind === "remote-agent-call" &&
                dynamicSubagentSelection?.kind === "remote"
              ? dynamicSubagentSelection.remoteAgent
              : undefined,
        kind: "resume",
      };
    }
    throw new Error("Unknown or unregistered agent handle.");
  }
  return classifyFreshStart(input);
}

function classifyFreshStart(input: {
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
    const registration = getAgentRegistryState(input.session.state)?.handles.find(
      (handle) => handle.identity.id === action.input.agentId,
    )?.identity.registration;
    const destination = registration?.target;
    return {
      kind: "start",
      target: {
        action,
        dynamicRemoteAgent:
          destination?.kind === "remote"
            ? {
                description: registration!.description,
                path: EVE_SESSION_ROUTE_PATH,
                url: destination.url,
                publicUrl: true,
              }
            : dynamicSubagentSelection?.kind === "remote"
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

function ownerPlanSharesSandbox(input: {
  readonly bundle: CompiledBundle;
  readonly plan: readonly OwnerAgentDispatchPlanEntry[];
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
        .inheritsParent === true
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
  readonly handles?: readonly AgentRegistryEntry[];
  readonly allowUnregistered?: boolean;
}): RuntimeAgentDispatchRequest {
  const bundle = input.ctx.require(BundleKey);
  const referenceId = input.input.agentId ?? input.input.target;
  const reference =
    input.handles?.find((handle) => handle.identity.id === referenceId) ??
    (input.input.agentId === undefined
      ? input.handles?.find(
          (handle) =>
            handle.identity.registration?.visible === true &&
            handle.identity.registration.key === input.input.target,
        )
      : undefined);
  if (reference) {
    const registration = reference.identity.registration;
    if (registration?.visible === false && !input.allowUnregistered)
      throw new Error("Unknown or unregistered agent handle.");
    const remote =
      registration?.target.kind === "remote" ||
      bundle.subagentRegistry.subagentsByNodeId.get(reference.identity.nodeId)?.definition.kind ===
        "remote";
    const actionInput: { message: string; agentId: string; outputSchema?: JsonObject } = {
      message: input.input.message,
      agentId: reference.identity.id,
    };
    if (input.input.outputSchema !== undefined) actionInput.outputSchema = input.input.outputSchema;
    const common = {
      callId: input.invocationId,
      description: registration?.description ?? "",
      input: actionInput,
      name: reference.identity.name,
      nodeId: reference.identity.nodeId,
    };
    return remote
      ? { ...common, kind: "remote-agent-call", remoteAgentName: reference.identity.name }
      : { ...common, kind: "subagent-call", subagentName: reference.identity.name };
  }
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
