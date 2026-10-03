import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
} from "@opentelemetry/api";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";
import { withErrorContent } from "#tracing/eve/otel.js";
import { markAgentTraceContext } from "#tracing/eve/agent-trace-context.js";

export interface ChannelRequestTrace {
  readonly reference: import("@opentelemetry/api").SpanContext;
  channel(input: { channelName?: string; channelKind?: string }): void;
}
const headersGetter: TextMapGetter<Headers> = {
  get: (headers, key) => headers.get(key) ?? undefined,
  keys: (headers) => [...headers.keys()],
};

/** The request lifetime ends at handler return, not response-body consumption. */
export async function traceChannelRequest<T extends Response>(
  input: { readonly request: Request; readonly routeKey: string },
  handler: (operation: ChannelRequestTrace | undefined) => Promise<T>,
): Promise<T> {
  if (getInstrumentationRuntime()?.otelSettings?.traceChannelRequests !== true)
    return handler(undefined);
  const { request, routeKey } = input;
  const parent = propagation.extract(context.active(), request.headers, headersGetter);
  const separator = routeKey.indexOf(" ");
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {}
  const span = trace.getTracer("eve.channel").startSpan(
    "agent.channel.request",
    {
      kind: SpanKind.SERVER,
      attributes: {
        "operation.name": "agent.channel.request",
        "resource.name": "agent.channel.request",
        "http.request.method": request.method,
        "http.route": separator === -1 ? routeKey : routeKey.slice(separator + 1),
        "url.scheme": url?.protocol.replace(/:$/, ""),
        "server.address": url?.hostname,
      },
    },
    parent,
  );
  const operation: ChannelRequestTrace = {
    reference: span.spanContext(),
    channel(input) {
      if (input.channelName !== undefined)
        span.setAttribute("agent.channel.name", input.channelName);
      if (input.channelName !== undefined) span.setAttribute("eve.channel.name", input.channelName);
      if (input.channelKind !== undefined)
        span.setAttribute("agent.channel.kind", input.channelKind);
      if (input.channelKind !== undefined) span.setAttribute("eve.channel.kind", input.channelKind);
    },
  };
  try {
    const response = await context.with(
      markAgentTraceContext(withErrorContent(trace.setSpan(parent, span), false)),
      () => handler(operation),
    );
    span.setAttribute("http.response.status_code", response.status);
    if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    return response;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
