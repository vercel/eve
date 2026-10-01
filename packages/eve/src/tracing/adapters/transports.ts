import { createTraceEngine } from "#tracing/core/engine.js";
import { namingAttributes } from "#tracing/core/attributes.js";
import type {
  Attributes,
  CaptureDecision,
  TraceBackend,
  TraceReference,
} from "#tracing/core/types.js";

export function createTransportTracing(backend: TraceBackend) {
  const engine = createTraceEngine({ backend });
  return {
    async request<T extends { status: number }>(
      input: {
        method: string;
        route: string;
        parent?: TraceReference;
        scheme?: string;
        serverAddress?: string;
        channelName?: string;
        channelKind?: string;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const capture = { emit: true, recordInputs: false, recordOutputs: false };
      const operation = engine.start(
        {
          type: "channelRequest",
          operationId: `${input.method} ${input.route}`,
          name: "agent.channel.request",
          kind: "SERVER",
          parent: input.parent,
          attributes: {
            ...namingAttributes("agent.channel.request"),
            "http.request.method": input.method,
            "http.route": input.route,
            "url.scheme": input.scheme,
            "server.address": input.serverAddress,
            "agent.channel.name": input.channelName,
            "agent.channel.kind": input.channelKind,
          },
        },
        capture,
      );
      try {
        const response = await operation.run(execute);
        operation.setAttribute("http.response.status_code", response.status);
        if (response.status >= 500) operation.setStatus("ERROR");
        return response;
      } catch (error) {
        operation.setStatus("ERROR");
        throw error;
      } finally {
        operation.end();
      }
    },
    async mcp<T>(
      input: {
        method: "tools/list" | "tools/call";
        connectionName: string;
        toolName?: string;
        protocolVersion?: string;
        parent?: TraceReference;
        capture: CaptureDecision;
        attributes?: Attributes;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = engine.start(
        {
          type: "mcp",
          operationId: `${input.connectionName}:${input.method}`,
          name:
            input.method === "tools/call"
              ? `tools/call ${input.toolName ?? "unknown"}`
              : "tools/list",
          kind: "CLIENT",
          parent: input.parent,
          attributes: {
            ...input.attributes,
            "agent.connection.name": input.connectionName,
            "mcp.method.name": input.method,
            "mcp.protocol.version": input.protocolVersion,
            "network.protocol.name": "http",
            "network.transport": "tcp",
            ...(input.method === "tools/call"
              ? { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": input.toolName }
              : undefined),
          },
        },
        input.capture,
      );
      try {
        return await operation.run(execute);
      } catch (error) {
        operation.fail(error);
        throw error;
      } finally {
        operation.end();
      }
    },
  };
}
