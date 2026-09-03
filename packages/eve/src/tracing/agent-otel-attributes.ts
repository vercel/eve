export const AGENT_INVOCATION_ROLES = {
  caller: "caller",
} as const;

export const AGENT_TRACE_ATTRIBUTES = {
  childTraceId: "agent.child.trace.id",
  invocationRole: "agent.invocation.role",
  principalCurrentId: "agent.principal.current.id",
  principalCurrentType: "agent.principal.current.type",
  principalInitiatorId: "agent.principal.initiator.id",
  principalInitiatorType: "agent.principal.initiator.type",
} as const;
