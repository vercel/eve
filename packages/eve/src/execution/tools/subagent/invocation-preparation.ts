import { deserializeContext } from "#context/serialize.js";
import {
  prepareActionDispatch,
  type PreparedCoordinationDispatch,
} from "#execution/coordination-dispatch-shared.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import type { AgentInvocationRequest } from "#execution/tools/subagent/invocation.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { AGENT_TOOL_DESCRIPTION, AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";
import {
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type DurableDynamicSubagentSelection,
} from "#context/keys.js";

/** Prepares one workflow-owner agent invocation from durable inputs. */
export async function prepareOwnerAgentInvocation(input: {
  readonly invocation: AgentInvocationRequest["input"];
  readonly invocationId: string;
  readonly knownAgentIds?: readonly string[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<PreparedCoordinationDispatch> {
  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const event = getHarnessEmissionState(durableSession.state);
  const action = resolveAgentInvocationAction({
    ctx,
    input: input.invocation,
    invocationId: input.invocationId,
  });
  return await prepareActionDispatch({
    batch: {
      requests: [action],
      event: { ...event, turnId: activeTurnId(event) },
    },
    ctx,
    durableSession,
    knownAgentIds: input.knownAgentIds,
    serializedContext: input.serializedContext,
  });
}

function resolveAgentInvocationAction(input: {
  readonly ctx: Awaited<ReturnType<typeof deserializeContext>>;
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
    outputSchema?: import("#shared/json.js").JsonObject;
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
