import type { ContextReader } from "#context/key.js";
import { deserializeContext } from "#context/serialize.js";
import {
  prepareActionDispatch,
  type PreparedCoordinationDispatch,
} from "#execution/coordination-dispatch-shared.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentDispatchFailure,
} from "#shared/action-types.js";
import type { AgentInvocationRequest } from "#execution/tools/subagent/invoke-agent.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import {
  isAgentHandleAction,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#subagents/handle-dispatch.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import {
  getDynamicSubagentSelection,
  readDynamicSubagentSelections,
} from "#context/dynamic-subagent-lifecycle.js";
import { resolveAgentAction, resolveAgentStartTarget } from "#execution/agent-sessions/target.js";
import type { SubagentStartTarget } from "#execution/tools/subagent/start.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.agent-invocation");

type OwnerAgentDispatchPlanEntry =
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
}): Promise<Omit<PreparedCoordinationDispatch<OwnerAgentDispatchPlanEntry>, "sessionState">> {
  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const event = getHarnessEmissionState(durableSession.state);
  const action = resolveAgentAction({
    bundle: ctx.require(BundleKey),
    callId: input.invocationId,
    dynamicSelections: readDynamicSubagentSelections(ctx),
    input: input.invocation,
  });
  return await prepareActionDispatch({
    batch: {
      requests: [action],
      event: { ...event, turnId: activeTurnId(event) },
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
    planReusesOwnerSandbox: ({ bundle, plan }) => ownerPlanReusesSandbox({ bundle, plan }),
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
      (getAgentHandleStore(input.session.state)?.handles ?? []).map((handle) => handle.identity.id),
  );
  const rawAgentId = input.action.input.agentId;
  const agentId =
    typeof rawAgentId === "string" && rawAgentId.trim() !== "" ? rawAgentId : undefined;
  if (agentId !== undefined && isAgentHandleAction(input.action)) {
    if (knownAgentIds.has(agentId)) {
      const dynamicSubagentSelection =
        input.bundle.subagentRegistry.dynamicNodeIds?.has(input.action.nodeId) === true
          ? getDynamicSubagentSelection(input.ctx, input.action.nodeId)
          : undefined;
      return {
        action: input.action,
        agentId,
        dynamicRemoteAgent:
          input.action.kind === "remote-agent-call" && dynamicSubagentSelection?.kind === "remote"
            ? dynamicSubagentSelection.remoteAgent
            : undefined,
        kind: "resume",
      };
    }
    log.warn("unknown agentId on subagent call; starting a new agent", {
      agentId,
      callId: input.action.callId,
    });
  }
  return resolveAgentStartTarget({
    action: input.action,
    bundle: input.bundle,
    dynamicSelections: readDynamicSubagentSelections(input.ctx),
    isRootSession: input.session.rootSessionId === undefined,
  });
}

function ownerPlanReusesSandbox(input: {
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
        .kind === "parent"
    );
  });
}
