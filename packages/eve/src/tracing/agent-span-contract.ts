export const AGENT_TRACE_SCHEMA_VERSION = 4;

export const AGENT_SPAN_NAMES = {
  action: "agent.action",
  approval: "agent.approval",
  channelRequest: "agent.channel.request",
  step: "agent.step",
} as const;

export const AGENT_USAGE_ATTRIBUTES = {
  costUsd: "agent.usage.cost_usd",
  inputTokens: "agent.usage.input_tokens",
  outputTokens: "agent.usage.output_tokens",
  cacheReadTokens: "agent.usage.cache_read_tokens",
  cacheWriteTokens: "agent.usage.cache_write_tokens",
} as const;

export function agentInvocationSpanName(agentName: string | undefined): string {
  return agentName === undefined ? "invoke_agent" : `invoke_agent ${agentName}`;
}

export function modelSpanName(modelId: string): string {
  return `chat ${modelId}`;
}

export interface AgentSamplingOperation {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>>;
}

interface AgentSpanRecord {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Marks the `execute_tool` span of a tool call made outside any conversation. */
export const DIRECT_TOOL_CALL_ATTRIBUTE = "eve.tool.invocation";
export const DIRECT_TOOL_CALL_VALUE = "direct";

/**
 * A direct tool call has no turn, so its own span is what starts and ends
 * its claim on the trace, the way an activation span does for a turn.
 */
export function isDirectToolCallSpan(span: Pick<AgentSpanRecord, "attributes">): boolean {
  return span.attributes[DIRECT_TOOL_CALL_ATTRIBUTE] === DIRECT_TOOL_CALL_VALUE;
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
  const sessionId = span.attributes["agent.run.id"];
  const turnId = span.attributes["agent.turn.id"];
  return typeof turnId === "string"
    ? `${typeof sessionId === "string" ? sessionId : ""}\0${turnId}`
    : undefined;
}
