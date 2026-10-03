import type { Attributes, SpanType } from "./types.js";
export const SPAN_NAMES = {
  action: "agent.action",
  approval: "agent.approval",
  step: "agent.step",
} as const;
export const USAGE_FIELDS = {
  costUsd: "agent.usage.cost_usd",
  inputTokens: "agent.usage.input_tokens",
  outputTokens: "agent.usage.output_tokens",
  cacheReadTokens: "agent.usage.cache_read_tokens",
  cacheWriteTokens: "agent.usage.cache_write_tokens",
} as const;
export const invocationName = (name?: string) =>
  name === undefined ? "invoke_agent" : `invoke_agent ${name}`;
export const modelName = (name: string) => `chat ${name}`;
export const toolName = (name: string) => `execute_tool ${name}`;
export interface ChannelMetadata {
  readonly kind?: string;
  readonly origin?: string;
}
export function mcpAttributes(input: {
  connectionName: string;
  method: string;
  toolName?: string;
  protocolVersion?: string;
  requestId?: string;
}): Attributes {
  return {
    "agent.connection.name": input.connectionName,
    "mcp.method.name": input.method,
    "network.protocol.name": "http",
    "network.transport": "tcp",
    "mcp.protocol.version": input.protocolVersion,
    "jsonrpc.request.id": input.requestId,
    "gen_ai.operation.name": input.method === "tools/call" ? "execute_tool" : undefined,
    "gen_ai.tool.name": input.method === "tools/call" ? input.toolName : undefined,
  };
}
export const CONTENT_FIELDS = {
  toolArguments: "gen_ai.tool.call.arguments",
  toolResult: "gen_ai.tool.call.result",
  approvalRequest: "agent.approval.request",
  approvalResponse: "agent.approval.response",
  memoryRecords: "gen_ai.memory.records",
} as const;
export function terminalAttributes(type: SpanType, outcome: string): Attributes {
  return type === "activation"
    ? { "agent.turn.outcome": outcome }
    : type === "action"
      ? { "agent.action.outcome": outcome }
      : type === "approval"
        ? { "agent.approval.outcome": outcome }
        : {};
}
export const actionErrorAttributes = (code: string): Attributes => ({
  "agent.action.error.code": code,
});
export const memoryCountAttributes = (count: number): Attributes => ({
  "gen_ai.memory.record.count": count,
});
export const mcpSessionAttributes = (id: string): Attributes => ({ "mcp.session.id": id });
export const rpcStatusAttributes = (code: number | string): Attributes => ({
  "rpc.response.status_code": code,
});
export function applyAttributes(
  span: { setAttribute(key: string, value: Exclude<Attributes[string], undefined>): unknown },
  attributes: Attributes,
): void {
  for (const [key, value] of Object.entries(attributes))
    if (value !== undefined) span.setAttribute(key, value);
}
