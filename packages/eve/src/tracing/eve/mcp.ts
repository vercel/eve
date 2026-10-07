import {
  context as otelContext,
  propagation,
  trace,
  type Context as OtelContext,
  type TextMapSetter,
} from "@opentelemetry/api";

import { otelTelemetry, type CaptureDecision, type ContentSerializer } from "#tracing/lib/index.js";
import {
  activeTraceOperation,
  contentAttribute,
  mcpLifecycle,
  truncateTelemetryText,
  type McpLifecycle,
  type McpUpdate,
} from "#tracing/lib/otel.js";
import { eveOutputMapping } from "./profile.js";
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Context = Pick<OtelContext, "getValue">;
const MAX_MCP_TRACE_REQUEST_BYTES = 1024 * 1024;
const MAX_MCP_TRACE_CONTEXT_BYTES = 8192;
const utf8Encoder = new TextEncoder();
const traceContextSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export function createMcpTraceFetch(input: {
  readonly connectionName: string;
  readonly fetcher?: typeof fetch;
  readonly getActiveContext?: () => Context;
  readonly getProtocolVersion: () => string | undefined;
  readonly injectContext?: McpTraceContextInjector;
  readonly filterCarrier?: (carrier: Record<string, string>) => void;
}): typeof fetch {
  const fetcher = input.fetcher ?? ((request, init) => globalThis.fetch(request, init));
  const getActiveContext = input.getActiveContext ?? (() => otelContext.active());
  const injectContext = input.injectContext ?? injectOpenTelemetryTraceContext;

  return async (request, init) => {
    const message = readJsonRpcRequest(init?.body);
    if (message === undefined) return await fetcher(request, init);

    const activeContext = getActiveContext();
    const propagated = injectMcpTraceContext(
      message,
      activeContext,
      injectContext,
      input.filterCarrier,
    );
    const annotateRequest =
      message.method === "tools/call" ||
      (message.method === "tools/list" && activeTraceOperation(activeContext)?.type === "mcp");
    if (annotateRequest) {
      activeTraceOperation(activeContext)?.mcp?.update(
        mcpRequestMetadata({
          connectionName: input.connectionName,
          message,
          params: isObject(message.params) ? message.params : {},
          protocolVersion:
            headerValue(init?.headers, "mcp-protocol-version") ?? input.getProtocolVersion(),
        }),
      );
    }

    const response = await fetcher(
      request,
      propagated === undefined ? init : { ...init, body: JSON.stringify(propagated) },
    );
    if (annotateRequest) {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId !== null) {
        activeTraceOperation(activeContext)?.mcp?.update({
          sessionId: truncateTelemetryText(sessionId, 512),
        });
      }
    }
    return response;
  };
}

function injectMcpTraceContext(
  message: JsonRpcRequest,
  activeContext: Context,
  injectContext: McpTraceContextInjector = injectOpenTelemetryTraceContext,
  filterCarrier?: (carrier: Record<string, string>) => void,
): JsonRpcRequest | undefined {
  if (!withinTraceRequestLimit(JSON.stringify(message))) return undefined;

  if (message.params !== undefined && !isObject(message.params)) return undefined;
  const propagated: Record<string, string> = {};
  injectContext(activeContext, propagated);
  if (!withinTraceContextLimit(propagated)) return undefined;
  filterCarrier?.(propagated);

  const params = isObject(message.params) ? message.params : {};
  const existingMeta = isObject(params["_meta"]) ? params["_meta"] : {};
  return {
    ...message,
    params: {
      ...params,
      _meta: { ...existingMeta, ...propagated },
    },
  };
}

const noContent = () => undefined;
/** Records only JSON tool arguments and results, as MCP spans carry no model content. */
export const MCP_SERIALIZER: ContentSerializer = {
  json: contentAttribute,
  text: noContent,
  inputMessages: noContent,
  instructions: noContent,
  toolDefinitions: noContent,
  outputMessages: noContent,
  toolResults: noContent,
};

export function createMcpTracing() {
  const telemetry = otelTelemetry({ tracerName: "eve.mcp", mapping: eveOutputMapping() });
  function start(input: {
    method: "tools/list" | "tools/call";
    connectionName: string;
    toolName?: string;
    protocolVersion?: string;
    executionContext: OtelContext;
    capture: CaptureDecision;
  }) {
    const span = telemetry.startSpan(
      {
        type: "mcp",
        operationId: `${input.connectionName}:${input.method}`,
        name:
          input.method === "tools/call"
            ? `tools/call ${input.toolName ?? "unknown"}`
            : input.method,
        kind: "CLIENT",
        parent: trace.getSpan(input.executionContext)?.spanContext(),
        attributes: {
          "agent.connection.name": input.connectionName,
          "mcp.method.name": input.method,
          "network.protocol.name": "http",
          "network.transport": "tcp",
          "mcp.protocol.version": input.protocolVersion,
          "gen_ai.operation.name": input.method === "tools/call" ? "execute_tool" : undefined,
          "gen_ai.tool.name": input.toolName,
        },
      },
      { context: input.executionContext },
    );
    const semantic = mcpLifecycle({
      serializer: MCP_SERIALIZER,
      ...input.capture,
      write(attributes) {
        for (const [key, value] of Object.entries(attributes))
          if (value !== undefined) span.setAttribute(key, value);
      },
      error: span.fail,
    });
    return {
      ...semantic,
      end: span.end,
      run<T>(execute: () => T): T {
        return telemetry.run(
          { type: "mcp", reference: span.reference, capture: input.capture, mcp: semantic },
          execute,
          input.executionContext,
        );
      },
    };
  }
  return {
    async list<T>(input: {
      readonly connectionName: string;
      readonly execute: () => Promise<T>;
      readonly protocolVersion?: string;
    }): Promise<T> {
      const parent = otelContext.active();
      const span = start({
        method: "tools/list",
        connectionName: input.connectionName,
        protocolVersion: input.protocolVersion,
        executionContext: parent,
        capture: activeTraceOperation()?.capture ?? {
          emit: true,
          recordInputs: false,
          recordOutputs: false,
        },
      });
      try {
        return await span.run(async () => {
          try {
            return await input.execute();
          } catch (error) {
            const code = jsonRpcErrorCode(error);
            if (code !== undefined) {
              span.update({ statusCode: code });
            }
            span.error(error, errorType(error, code));
            throw error;
          }
        });
      } finally {
        span.end();
      }
    },
    async call<T>(input: {
      readonly arguments: unknown;
      readonly connectionName: string;
      readonly execute: () => Promise<T>;
      readonly protocolVersion?: string;
      readonly toolName: string;
    }): Promise<T> {
      const parent = otelContext.active();
      const existing = activeTraceOperation();
      if (existing?.type === "tool" && existing.mcp !== undefined) {
        existing.mcp.update({ ...input, method: "tools/call" });
        return await runMcpToolCall(input, undefined);
      }

      const span = start({
        method: "tools/call",
        connectionName: input.connectionName,
        toolName: truncateTelemetryText(input.toolName, 128),
        protocolVersion: input.protocolVersion,
        executionContext: parent,
        capture: existing?.capture ?? { emit: true, recordInputs: false, recordOutputs: false },
      });
      try {
        return await span.run(() => runMcpToolCall(input, span));
      } finally {
        span.end();
      }
    },
  };
}

function runMcpToolCall<T>(
  input: {
    readonly arguments: unknown;
    readonly execute: () => Promise<T>;
  },
  fallbackSpan: McpLifecycle | undefined,
): Promise<T> {
  if (fallbackSpan !== undefined) {
    fallbackSpan.arguments(input.arguments);
  }

  return input
    .execute()
    .then((result) => {
      if (isToolErrorResult(result)) {
        activeTraceOperation()?.mcp?.error(undefined, "tool_error");
      }
      if (fallbackSpan !== undefined) {
        fallbackSpan.result(result);
      }
      return result;
    })
    .catch((error: unknown) => {
      const code = jsonRpcErrorCode(error);
      if (code !== undefined) {
        activeTraceOperation()?.mcp?.update({ statusCode: code });
      }
      if (fallbackSpan !== undefined) {
        activeTraceOperation()?.mcp?.error(error, errorType(error, code));
      }
      throw error;
    });
}

function mcpRequestMetadata(input: {
  readonly connectionName: string;
  readonly message?: JsonRpcRequest;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly protocolVersion?: string;
  readonly toolName?: string;
}): McpUpdate {
  const method = input.method ?? input.message?.method;
  const params = input.params ?? (isObject(input.message?.params) ? input.message.params : {});
  const toolName =
    input.toolName ?? (typeof params["name"] === "string" ? params["name"] : undefined);
  const requestId = input.message?.id;
  const meta = params["_meta"];
  const protocolVersion =
    input.protocolVersion ??
    (isObject(meta) && typeof meta["io.modelcontextprotocol/protocolVersion"] === "string"
      ? meta["io.modelcontextprotocol/protocolVersion"]
      : undefined);
  return {
    connectionName: input.connectionName,
    method: method ?? "unknown",
    toolName,
    protocolVersion,
    requestId:
      typeof requestId === "number" || typeof requestId === "string"
        ? String(requestId)
        : undefined,
  };
}

interface JsonRpcRequest extends Record<string, unknown> {
  readonly method: string;
  readonly params?: unknown;
}

type McpTraceContextInjector = (context: Context, carrier: Record<string, string>) => void;

function injectOpenTelemetryTraceContext(context: Context, carrier: Record<string, string>): void {
  propagation.inject(context as OtelContext, carrier, traceContextSetter);
}

function readJsonRpcRequest(body: RequestInit["body"]): JsonRpcRequest | undefined {
  if (typeof body !== "string" || !withinTraceRequestLimit(body)) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) && typeof value["method"] === "string"
      ? (value as JsonRpcRequest)
      : undefined;
  } catch {
    return undefined;
  }
}

function withinTraceRequestLimit(value: string): boolean {
  return (
    value.length <= MAX_MCP_TRACE_REQUEST_BYTES &&
    utf8Encoder.encode(value).byteLength <= MAX_MCP_TRACE_REQUEST_BYTES
  );
}

function withinTraceContextLimit(carrier: Readonly<Record<string, string>>): boolean {
  let bytes = 0;
  for (const [key, value] of Object.entries(carrier)) {
    if (key.length + value.length > MAX_MCP_TRACE_CONTEXT_BYTES) return false;
    bytes += utf8Encoder.encode(key).byteLength + utf8Encoder.encode(value).byteLength + 2;
    if (bytes > MAX_MCP_TRACE_CONTEXT_BYTES) return false;
  }
  return bytes > 0;
}

function headerValue(headers: RequestInit["headers"], name: string): string | undefined {
  if (headers === undefined) return undefined;
  try {
    return new Headers(headers).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function isToolErrorResult(value: unknown): boolean {
  return isObject(value) && value["isError"] === true;
}

function jsonRpcErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  const code = error["code"];
  return typeof code === "number" || typeof code === "string" ? String(code) : undefined;
}

function errorType(error: unknown, code: string | undefined): string | undefined {
  if (code !== undefined) return code;
  return error instanceof Error ? error.name || "Error" : undefined;
}
