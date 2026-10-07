import type {
  AgentSessionTraceState,
  AgentTurnTraceState,
} from "#tracing/eve/agent-trace-state.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import type { TurnInput } from "#tracing/lib/index.js";
import { checkpointContent } from "#tracing/eve/operation-input.js";

export function eveActivationMetadata(input: {
  readonly session?: AgentSessionTraceState;
  readonly turn: AgentTurnTraceState;
  readonly sessionId: string;
}): Pick<TurnInput, "sequence" | "lineage" | "channel" | "attributes"> {
  const { session, turn, sessionId } = input;
  const lineage = turn.parentLineage ?? session?.parentLineage;
  const owns = lineage === undefined || turn.traceSessionId === sessionId;
  const delivery = turn.channelDelivery;
  const kind =
    delivery?.channelKind ??
    (!owns
      ? undefined
      : (session?.channelKind ??
        (session?.channelType === undefined
          ? undefined
          : normalizeInstrumentationChannelKind(session.channelType))));
  return {
    sequence: turn.sequence,
    lineage:
      lineage === undefined
        ? undefined
        : {
            agentName: turn.subagentName,
            parentCallId: lineage.callId,
            parentRunId: lineage.sessionId,
          },
    channel: {
      kind,
      origin:
        !owns || kind === undefined
          ? undefined
          : session?.scheduleId === undefined
            ? "channel"
            : "schedule",
    },
    attributes: {
      "agent.channel.audience": session?.channelAudience,
      "agent.session.title":
        owns && session?.decision?.action === "record" && session.decision.recordInputs
          ? session.title
          : undefined,
      "agent.schedule.id": lineage === undefined ? session?.scheduleId : undefined,
      "agent.principal.current.type": turn.currentPrincipal?.type,
      "agent.principal.current.id":
        turn.currentPrincipal && "id" in turn.currentPrincipal
          ? turn.currentPrincipal.id
          : undefined,
      "agent.principal.initiator.type": turn.initiatorPrincipal?.type,
      "agent.principal.initiator.id":
        turn.initiatorPrincipal && "id" in turn.initiatorPrincipal
          ? turn.initiatorPrincipal.id
          : undefined,
      "agent.channel.name": delivery?.channelName,
      "agent.channel.delivery.id": delivery?.deliveryId,
      "agent.channel.request.id": delivery?.requestId,
      "agent.channel.delivery.input":
        delivery?.inputAttribute === undefined
          ? undefined
          : JSON.stringify(checkpointContent(delivery.inputAttribute)),
    },
  };
}
