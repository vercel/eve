export const AGENT_INVOCATION_ROLES = {
  caller: "caller",
} as const;

export const AGENT_TRACE_ATTRIBUTES = {
  childTraceId: "agent.child.trace.id",
  invocationRole: "agent.invocation.role",
} as const;
