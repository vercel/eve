import type { ActivityObserverConfig } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type DurableDynamicSubagentSelection,
  type LocalDevRequestProvenance,
} from "#context/keys.js";
import {
  createRecursiveAgentRootOnlyResult,
  createUnavailableDynamicSubagentResult,
  getSubagentName,
} from "#execution/dispatch-action-failures.js";
import type { hydrateDurableSession } from "#execution/session.js";
import type { InternalAgentInput } from "#execution/tools/workflow/agent.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeRemoteAgentDispatchRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentDispatchRequest,
} from "#shared/action-types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import { START_FAILED } from "#subagents/agent-handle-errors.js";
import type { SubagentParentContext } from "#subagents/invocation.js";
import { resolveRemoteAgentForAction } from "#subagents/remote/dispatch.js";
import { startRemoteSubagent } from "#subagents/remote/start.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#subagents/tool.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import type { AgentChildTraceDispatch } from "#tracing/agent-invocation-coordinator.js";
import { resolveConversationId } from "#tracing/conversation-context.js";

// Owner-side start of an agent task's child: resolve the call to an agent,
// plan a fresh start, and create the local or remote child session.

const log = createLogger("execution.agent-invocation");
const localStartLog = createLogger("execution.subagent-start-local");

/** Hydrated parent session snapshot threaded through dispatch. */
export type RuntimeSession = ReturnType<typeof hydrateDurableSession>;

/**
 * Outcome of starting one child. A local child reports its own address to
 * the owner once it has claimed it; a remote child's address comes back from
 * the create request.
 */
export type DispatchOutcome =
  | {
      readonly kind: "started";
      readonly remote?: {
        readonly callbackBaseUrl: string;
        /** Auth and header resolver selected when the child was created. */
        readonly credentialResolver?: string;
        readonly sessionId: string;
        readonly url: string;
      };
    }
  | { readonly kind: "error"; readonly result: RuntimeSubagentDispatchFailure };

export type SubagentStartTarget =
  | {
      readonly kind: "local";
      readonly action: RuntimeSubagentDispatchRequest;
      readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
      readonly source: SubagentInputSource;
    }
  | {
      readonly kind: "remote";
      readonly action: RuntimeRemoteAgentDispatchRequest;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    };

export type OwnerAgentDispatchPlanEntry =
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: SubagentStartTarget };

/** Resolves an agent call to the dispatch request for the agent it names. */
export function resolveAgentInvocationAction(input: {
  readonly ctx: ContextReader;
  readonly input: InternalAgentInput;
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
    taskId?: string;
    message: string;
    outputSchema?: JsonObject;
  } = { message: input.input.message };
  if (input.input.taskId !== undefined) actionInput.taskId = input.input.taskId;
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

export function classifyFreshStart(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextReader;
  readonly session: RuntimeSession;
}): OwnerAgentDispatchPlanEntry {
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

/**
 * Starts one planned fresh child against its local or remote target. It does
 * not wait for a local child: the child claims its continuation address (so a
 * duplicate start exits) and then reports to its owner.
 */
export async function startSubagent(input: {
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly inheritedConversation?: Parameters<
    typeof buildSubagentRunInput
  >[0]["inheritedConversation"];
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  /** Inherited originating-client metadata for the dev-TUI hint. */
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parentContinuationToken: string | undefined;
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly session: RuntimeSession;
  readonly target: SubagentStartTarget;
  readonly taskId: string;
  readonly trace: AgentChildTraceDispatch;
}): Promise<DispatchOutcome> {
  const { target, trace } = input;
  const parent: SubagentParentContext = {
    conversationId:
      trace.conversationId ??
      resolveConversationId(input.session.rootSessionId ?? input.session.sessionId),
    lineage: {
      callId: target.action.callId,
      rootSessionId: input.session.rootSessionId ?? input.session.sessionId,
      sessionId: input.session.sessionId,
      turn: { id: input.batchEvent.turnId, sequence: input.batchEvent.sequence },
    },
    continuationToken: input.parentContinuationToken,
    traceContext: trace.parentTraceContext,
    originAudience: trace.originAudience,
  };

  if (target.kind === "remote") {
    return startRemoteSubagent({
      action: target.action,
      auth: input.auth,
      bundle: input.bundle,
      callbackBaseUrl: input.callbackBaseUrl,
      capabilities: input.capabilities,
      dynamicRemoteAgent: target.dynamicRemoteAgent,
      initiatorAuth: input.initiatorAuth,
      parent,
      activityObserver: input.activityObserver,
      session: input.session,
    });
  }

  const { action, source } = target;
  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig: target.dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  const { runInput } = buildSubagentRunInput({
    action,
    auth: input.auth,
    capabilities: input.capabilities,
    channelMetadata: input.channelMetadata,
    inheritedConversation: input.inheritedConversation,
    fanoutSize: input.fanoutSize,
    initiatorAuth: input.initiatorAuth,
    graph: input.bundle.graph,
    parent,
    activityObserver: input.activityObserver,
    sandboxSessionId: input.sandboxSessionId,
    session: input.session,
    selfAgent: source.type === "runtime",
    source,
    taskId: input.taskId,
  });
  try {
    await contextStorage.run(new ContextContainer({ localDevRequest: input.localDevRequest }), () =>
      childRuntime.createSession(runInput),
    );
  } catch (error) {
    logError(localStartLog, "local subagent start failed", error, {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    return {
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: { code: START_FAILED, message: toErrorMessage(error) },
        subagentName: action.subagentName,
      },
    };
  }
  return { kind: "started" };
}

/** Overlays current dynamic credentials without replacing stored delivery coordinates. */
export function createAgentContinuationBundle(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
}): CompiledBundle {
  const { action, dynamicRemoteAgent } = input;
  if (action.kind !== "remote-agent-call" || dynamicRemoteAgent === undefined) {
    return input.bundle;
  }

  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const subagentsByNodeId = Object.assign(new Map(registry), {
    get: (nodeId: string) =>
      nodeId === action.nodeId
        ? {
            definition: resolveRemoteAgentForAction({
              dynamicRemoteAgent,
              nodeId,
              registry,
              remoteAgentName: action.remoteAgentName,
            }),
          }
        : registry.get(nodeId),
  });

  return {
    ...input.bundle,
    subagentRegistry: { ...input.bundle.subagentRegistry, subagentsByNodeId },
  };
}
