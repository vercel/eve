import { createMcpTraceFetch as traceFetch } from "#tracing/eve/mcp.js";
import { eveMcpTracing } from "#tracing/eve/transports.js";
import { replaceBaggageMember } from "#protocol/baggage.js";

export function createMcpTraceFetch(input: Parameters<typeof traceFetch>[0]): typeof fetch {
  return traceFetch({
    ...input,
    filterCarrier(carrier) {
      let baggage = carrier.baggage;
      for (const key of ["eve.audience", "eve.conversation.id", "eve.parent_session"])
        baggage = replaceBaggageMember(baggage, key, undefined);
      if (baggage === undefined) delete carrier.baggage;
      else carrier.baggage = baggage;
    },
  });
}

export function withMcpToolsListSpan<T>(input: {
  connectionName: string;
  protocolVersion?: string;
  execute: () => Promise<T>;
}): Promise<T> {
  return eveMcpTracing().list(input);
}

export function withMcpToolCallSpan<T>(input: {
  connectionName: string;
  protocolVersion?: string;
  toolName: string;
  arguments: unknown;
  execute: () => Promise<T>;
}): Promise<T> {
  return eveMcpTracing().call(input);
}
