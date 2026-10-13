import { stripEveTraceBaggage } from "#protocol/baggage.js";
import { createMcpTraceFetch as traceFetch } from "#tracing/eve/mcp.js";
import { createMcpTracing } from "#tracing/eve/mcp.js";

export function createMcpTraceFetch(input: Parameters<typeof traceFetch>[0]): typeof fetch {
  return traceFetch({ ...input, filterCarrier: stripEveTraceBaggage });
}

export function withMcpToolsListSpan<T>(input: {
  connectionName: string;
  protocolVersion?: string;
  execute: () => Promise<T>;
}): Promise<T> {
  return createMcpTracing().list(input);
}

export function withMcpToolCallSpan<T>(input: {
  connectionName: string;
  protocolVersion?: string;
  toolName: string;
  arguments: unknown;
  execute: () => Promise<T>;
}): Promise<T> {
  return createMcpTracing().call(input);
}
