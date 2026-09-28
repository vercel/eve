import {
  context as otelContext,
  createContextKey,
  propagation,
  SpanKind,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TextMapSetter,
} from "#compiled/@opentelemetry/api/index.js";

import { contentAttribute } from "#tracing/agent-otel-content.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
import {
  agentToolContentPolicy,
  agentToolSpanContext,
  annotateAgentToolSpan,
  recordAgentToolSpanError,
  withAgentToolSpanContext,
} from "#tracing/agent-tool-span-context.js";
import { truncateTelemetryText } from "#tracing/telemetry-budget.js";
import { replaceBaggageMember } from "#protocol/baggage.js";
import { isObject } from "#shared/guards.js";

const MAX_MCP_TRACE_REQUEST_BYTES = 1024 * 1024;
const MAX_MCP_TRACE_CONTEXT_BYTES = 8192;
const utf8Encoder = new TextEncoder();
const EVE_TRACE_BAGGAGE_KEYS = [
  "eve.audience",
  "eve.conversation.id",
  "eve.parent_session",
] as const;
const traceContextSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};
const MCP_METHOD_NAME_CONTEXT_KEY = createContextKey("eve.mcp.method-name");

export function createMcpTraceFetch(input: {
  readonly connectionName: string;
  readonly fetcher?: typeof fetch;
  readonly getActiveContext?: () => Context;
  readonly getProtocolVersion: () => string | undefined;
  readonly injectContext?: McpTraceContextInjector;
}): typeof fetch {
  const fetcher = input.fetcher ?? ((request, init) => globalThis.fetch(request, init));
  const getActiveContext = input.getActiveContext ?? (() => otelContext.active());
  const injectContext = input.injectContext ?? injectOpenTelemetryTraceContext;

  return async (request, init) => {
    const message = readJsonRpcRequest(init?.body);
    if (message === undefined) return await fetcher(request, init);

    const activeContext = getActiveContext();
    const propagated = injectMcpTraceContext(message, activeContext, injectContext);
    const annotateRequest =
      message.method === "tools/call" || mcpMethodName(activeContext) === message.method;
    if (annotateRequest) {
      annotateAgentToolSpan(
        mcpRequestAttributes({
          connectionName: input.connectionName,
          message,
          params: isObject(message.params) ? message.params : {},
          protocolVersion:
            headerValue(init?.headers, "mcp-protocol-version") ?? input.getProtocolVersion(),
        }),
        activeContext,
      );
    }

    const response = await fetcher(
      request,
      propagated === undefined ? init : { ...init, body: JSON.stringify(propagated) },
    );
    if (annotateRequest) {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId !== null) {
        annotateAgentToolSpan(
          { "mcp.session.id": truncateTelemetryText(sessionId, 512) },
          activeContext,
        );
      }
    }
    return response;
  };
}

function injectMcpTraceContext(
  message: JsonRpcRequest,
  activeContext: Context,
  injectContext: McpTraceContextInjector = injectOpenTelemetryTraceContext,
): JsonRpcRequest | undefined {
  if (!withinTraceRequestLimit(JSON.stringify(message))) return undefined;

  if (message.params !== undefined && !isObject(message.params)) return undefined;
  const propagated: Record<string, string> = {};
  injectContext(activeContext, propagated);
  if (!withinTraceContextLimit(propagated)) return undefined;
  stripEveTraceBaggage(propagated);

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

export async function withMcpToolsListSpan<T>(input: {
  readonly connectionName: string;
  readonly execute: () => Promise<T>;
  readonly protocolVersion?: string;
}): Promise<T> {
  const parent = otelContext.active();
  const attributes = mcpRequestAttributes({
    connectionName: input.connectionName,
    method: "tools/list",
    protocolVersion: input.protocolVersion,
  });
  const span = trace.getTracer("eve.mcp").startSpan(
    "tools/list",
    {
      attributes,
      kind: SpanKind.CLIENT,
    },
    parent,
  );
  const spanContext = withMcpMethodName(
    withAgentToolSpanContext(trace.setSpan(parent, span), {
      ...agentToolContentPolicy(parent),
      recordError: (error, errorType) => recordAgentSpanError(span, error, errorType),
      setAttributes: (spanAttributes) => setSpanAttributes(span, spanAttributes),
    }),
    "tools/list",
  );
  try {
    return await otelContext.with(spanContext, async () => {
      try {
        return await input.execute();
      } catch (error) {
        const code = jsonRpcErrorCode(error);
        if (code !== undefined) {
          annotateAgentToolSpan({ "rpc.response.status_code": code }, spanContext);
        }
        recordAgentToolSpanError(error, errorType(error, code), spanContext);
        throw error;
      }
    });
  } finally {
    span.end();
  }
}

export async function withMcpToolCallSpan<T>(input: {
  readonly arguments: unknown;
  readonly connectionName: string;
  readonly execute: () => Promise<T>;
  readonly protocolVersion?: string;
  readonly toolName: string;
}): Promise<T> {
  const parent = otelContext.active();
  const existing = agentToolSpanContext(parent);
  const policy = agentToolContentPolicy(parent);
  if (existing?.setAttributes !== undefined) {
    annotateAgentToolSpan(mcpToolCallAttributes(input), parent);
    return await runMcpToolCall(input, parent, undefined, policy);
  }

  const span = trace.getTracer("eve.mcp").startSpan(
    `tools/call ${truncateTelemetryText(input.toolName, 128)}`,
    {
      attributes: mcpToolCallAttributes(input),
      kind: SpanKind.CLIENT,
    },
    parent,
  );
  const spanContext = withMcpMethodName(
    withAgentToolSpanContext(trace.setSpan(parent, span), {
      ...policy,
      recordError: (error, errorType) => recordAgentSpanError(span, error, errorType),
      setAttributes: (attributes) => setSpanAttributes(span, attributes),
    }),
    "tools/call",
  );

  try {
    return await otelContext.with(spanContext, () =>
      runMcpToolCall(input, spanContext, span, policy),
    );
  } finally {
    span.end();
  }
}

function runMcpToolCall<T>(
  input: {
    readonly arguments: unknown;
    readonly execute: () => Promise<T>;
  },
  context: Context,
  fallbackSpan: Span | undefined,
  policy: ReturnType<typeof agentToolContentPolicy>,
): Promise<T> {
  if (fallbackSpan !== undefined && policy.recordInputs) {
    const argumentsAttribute = contentAttribute(input.arguments);
    if (argumentsAttribute !== undefined) {
      fallbackSpan.setAttribute("gen_ai.tool.call.arguments", argumentsAttribute);
    }
  }

  return input
    .execute()
    .then((result) => {
      if (isToolErrorResult(result)) {
        recordAgentToolSpanError(undefined, "tool_error", context);
      }
      if (fallbackSpan !== undefined && policy.recordOutputs) {
        const resultAttribute = contentAttribute(result);
        if (resultAttribute !== undefined) {
          fallbackSpan.setAttribute("gen_ai.tool.call.result", resultAttribute);
        }
      }
      return result;
    })
    .catch((error: unknown) => {
      const code = jsonRpcErrorCode(error);
      if (code !== undefined) {
        annotateAgentToolSpan({ "rpc.response.status_code": code }, context);
      }
      if (fallbackSpan !== undefined) {
        recordAgentToolSpanError(error, errorType(error, code), context);
      }
      throw error;
    });
}

function mcpToolCallAttributes(input: {
  readonly connectionName: string;
  readonly protocolVersion?: string;
  readonly toolName: string;
}): Attributes {
  return mcpRequestAttributes({
    connectionName: input.connectionName,
    method: "tools/call",
    protocolVersion: input.protocolVersion,
    toolName: input.toolName,
  });
}

function mcpRequestAttributes(input: {
  readonly connectionName: string;
  readonly message?: JsonRpcRequest;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly protocolVersion?: string;
  readonly toolName?: string;
}): Attributes {
  const method = input.method ?? input.message?.method;
  const params = input.params ?? (isObject(input.message?.params) ? input.message.params : {});
  const attributes: Attributes = {
    "eve.connection.name": input.connectionName,
    "mcp.method.name": method ?? "unknown",
    "network.protocol.name": "http",
    "network.transport": "tcp",
  };
  const toolName =
    input.toolName ?? (typeof params["name"] === "string" ? params["name"] : undefined);
  if (method === "tools/call") {
    attributes["gen_ai.operation.name"] = "execute_tool";
    if (toolName !== undefined) attributes["gen_ai.tool.name"] = toolName;
  }
  const requestId = input.message?.id;
  if (typeof requestId === "number" || typeof requestId === "string") {
    attributes["jsonrpc.request.id"] = String(requestId);
  }
  const meta = params["_meta"];
  const protocolVersion =
    input.protocolVersion ??
    (isObject(meta) && typeof meta["io.modelcontextprotocol/protocolVersion"] === "string"
      ? meta["io.modelcontextprotocol/protocolVersion"]
      : undefined);
  if (protocolVersion !== undefined) {
    attributes["mcp.protocol.version"] = protocolVersion;
  }
  return attributes;
}

interface JsonRpcRequest extends Record<string, unknown> {
  readonly method: string;
  readonly params?: unknown;
}

type McpTraceContextInjector = (context: Context, carrier: Record<string, string>) => void;

function injectOpenTelemetryTraceContext(context: Context, carrier: Record<string, string>): void {
  propagation.inject(context, carrier, traceContextSetter);
}

function stripEveTraceBaggage(carrier: Record<string, string>): void {
  let baggage = carrier["baggage"];
  if (baggage === undefined) return;
  for (const key of EVE_TRACE_BAGGAGE_KEYS) {
    baggage = replaceBaggageMember(baggage, key, undefined);
  }
  if (baggage === undefined) delete carrier["baggage"];
  else carrier["baggage"] = baggage;
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

function setSpanAttributes(span: Span, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(name, value);
  }
}

function withMcpMethodName(context: Context, methodName: string): Context {
  return context.setValue(MCP_METHOD_NAME_CONTEXT_KEY, methodName);
}

function mcpMethodName(context: Context): string | undefined {
  const methodName = context.getValue(MCP_METHOD_NAME_CONTEXT_KEY);
  return typeof methodName === "string" ? methodName : undefined;
}
