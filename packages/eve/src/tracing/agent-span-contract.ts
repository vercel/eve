export const AGENT_TRACE_SCHEMA_VERSION = 4;

export const AGENT_SPAN_NAMES = {
  action: "agent.action",
  approval: "agent.approval",
  channelRequest: "agent.channel.request",
  step: "agent.step",
} as const;

export const AGENT_USAGE_ATTRIBUTES = {
  inputTokens: "agent.usage.input_tokens",
  outputTokens: "agent.usage.output_tokens",
  cacheReadTokens: "agent.usage.cache_read_tokens",
  cacheWriteTokens: "agent.usage.cache_write_tokens",
} as const;

export function agentInvocationSpanName(agentName: string | undefined): string {
  return agentName === undefined ? "invoke_agent" : `invoke_agent ${agentName}`;
}

export function workflowInvocationSpanName(workflowName: string): string {
  return `invoke_workflow ${workflowName}`;
}

export interface AgentSamplingOperation {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>>;
}

interface AgentSpanRecord {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export function isAgentActivationSpan(span: AgentSpanRecord): boolean {
  return (
    span.name === "agent.turn" ||
    (span.attributes["gen_ai.operation.name"] === "invoke_agent" &&
      span.attributes["agent.invocation.role"] !== "caller" &&
      typeof span.attributes["agent.turn.id"] === "string")
  );
}

export function agentTurnIdentity(span: AgentSpanRecord): string | undefined {
  const conversationId = span.attributes["gen_ai.conversation.id"];
  const turnId = span.attributes["agent.turn.id"];
  return typeof turnId === "string"
    ? `${typeof conversationId === "string" ? conversationId : ""}\0${turnId}`
    : undefined;
}
