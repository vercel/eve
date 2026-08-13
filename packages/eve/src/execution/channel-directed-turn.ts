import type { SessionCommand } from "#channel/types.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";

export type RouteRemoteCommand = Extract<SessionCommand, { readonly kind: "route-remote" }>;

/** Seeds a model-free canonical turn with one remote runtime action. */
export function prepareChannelDirectedTurn(input: {
  readonly command: RouteRemoteCommand;
  readonly session: HarnessSession;
}): HarnessSession {
  const emission = getHarnessEmissionState(input.session.state);
  const turnId = `turn_${String(emission.sequence)}`;
  const agentId = findRemoteAgentId(input.session, input.command.routeId);
  const actionInput: {
    agentId?: string;
    message: string;
    outputSchema?: typeof input.command.remote.outputSchema;
  } = {
    message: input.command.message,
  };
  if (agentId !== undefined) actionInput.agentId = agentId;
  if (input.command.remote.outputSchema !== undefined) {
    actionInput.outputSchema = input.command.remote.outputSchema;
  }
  const action: RuntimeRemoteAgentCallActionRequest = {
    callId: channelDirectedCallId(input.command.routeId, emission.sequence),
    remoteTarget: { config: input.command.remote, kind: "inline" },
    sessionMode: "conversation",
    description: input.command.remote.description,
    input: actionInput,
    kind: "remote-agent-call",
    messageFormat: "verbatim",
    name: input.command.routeId,
    nodeId: `$channel:${input.command.routeId}`,
    remoteAgentName: input.command.routeId,
  };
  return setPendingRuntimeActionBatch({
    actions: [action],
    event: { sequence: emission.sequence, stepIndex: 0, turnId },
    responseMessages: [],
    settlement: "pass-through",
    session: setHarnessEmissionState(input.session, {
      sessionStarted: emission.sessionStarted,
      sequence: emission.sequence,
      stepIndex: 0,
      turnId,
    }),
  });
}

export function channelDirectedCallId(routeId: string, sequence: number): string {
  return `route:${routeId}:${String(sequence)}`;
}

function findRemoteAgentId(session: HarnessSession, routeId: string): string | undefined {
  return getAgentHandleStore(session.state)?.handles.find(
    (handle) => handle.identity.name === routeId && handle.phase === "parked",
  )?.identity.id;
}
