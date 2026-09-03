import type { Attributes } from "#compiled/@opentelemetry/api/index.js";

import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import {
  AGENT_INVOCATION_ROLES,
  AGENT_SESSION_KINDS,
  AGENT_TRACE_ATTRIBUTES,
  AGENT_TRACE_SCHEMA_VERSION,
} from "#protocol/agent-invocation-trace.js";

export function agentExecutionAttributes(input: {
  readonly agentName?: string;
  readonly frameworkVersion: string;
  readonly sessionId: string;
  readonly turn: AgentTurnTraceState;
  readonly turnId: string;
}): Attributes {
  return {
    "agent.framework.name": "eve",
    "agent.framework.version": input.frameworkVersion,
    "agent.name": input.agentName,
    "agent.root_run.id": input.turn.rootSessionId,
    "agent.parent_run.id": input.turn.parentLineage?.sessionId,
    "agent.parent_call.id": input.turn.parentLineage?.callId,
    "agent.session.id": input.sessionId,
    [AGENT_TRACE_ATTRIBUTES.sessionKind]:
      input.turn.parentLineage === undefined
        ? AGENT_SESSION_KINDS.root
        : AGENT_SESSION_KINDS.delegated,
    [AGENT_TRACE_ATTRIBUTES.schemaVersion]: AGENT_TRACE_SCHEMA_VERSION,
    [AGENT_TRACE_ATTRIBUTES.invocationRole]: AGENT_INVOCATION_ROLES.execution,
    "agent.subagent.name": input.turn.subagentName,
    "agent.turn.id": input.turnId,
    "agent.turn.sequence": input.turn.sequence,
    "gen_ai.agent.name": input.agentName,
    "gen_ai.conversation.id": input.sessionId,
    "gen_ai.operation.name": "invoke_agent",
  };
}
