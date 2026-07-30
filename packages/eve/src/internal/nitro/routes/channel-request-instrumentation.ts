import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  trace,
} from "#compiled/@opentelemetry/api/index.js";
import { recordErrorOnSpan } from "#internal/logging.js";

/**
 * Stable tracer name for every inbound eve channel HTTP request. Kept
 * low-cardinality and independent of the agent so dashboards can group
 * request spans across deployments.
 */
const TRACER_NAME = "eve.channel";

/**
 * Reads OTel context from an inbound request's `Headers`. Header lookups
 * are case-insensitive, so this is a thin adapter over `Headers.get`.
 */
const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    return [...carrier.keys()];
  },
};

/** Inputs for {@link traceChannelRequest}. */
export interface TraceChannelRequestInput {
  readonly request: Request;
  readonly routeKey: string;
}

/**
 * Wraps one inbound channel HTTP request in an OTel `SERVER` span.
 *
 * The span is named for the low-cardinality registered `routeKey`
 * (`"POST /eve/v1/session/:sessionId"`), never the concrete URL, while the
 * `http.route` attribute carries only the path template — the OTel HTTP
 * semantic convention reserves `http.route` for the route template alone,
 * with the method in `http.request.method`. The span is started from the
 * context extracted off the incoming request headers so an upstream
 * `traceparent` becomes its parent and nested channel and Workflow spans
 * (`hook.resume` and outgoing HTTP) become its descendants.
 *
 * The handler runs inside the span's active context. When it returns, the
 * response status is recorded and a `>= 500` status marks the span as an
 * error. A thrown handler is recorded once and rethrown — handler
 * exceptions that eve already converts to a JSON 500 return normally and
 * are recorded by `logError` against this active span, so they are not
 * recorded a second time here. The span always ends in `finally`, without
 * waiting for `event.waitUntil()` work or streamed response bodies.
 *
 * This is observability-only: it never changes the response and performs no
 * synchronous span export in the request path, adding only minimal in-process
 * tracing overhead.
 */
export async function traceChannelRequest<T extends Response>(
  input: TraceChannelRequestInput,
  handler: (span: Span) => Promise<T>,
): Promise<T> {
  const { request, routeKey } = input;
  const parentContext = propagation.extract(context.active(), request.headers, headersGetter);
  const span = trace
    .getTracer(TRACER_NAME)
    .startSpan(
      routeKey,
      { attributes: baseAttributes(request, routeKey), kind: SpanKind.SERVER },
      parentContext,
    );
  const activeContext = trace.setSpan(parentContext, span);

  try {
    const response = await context.with(activeContext, () => handler(span));
    span.setAttribute("http.response.status_code", response.status);
    if (response.status >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return response;
  } catch (error) {
    recordErrorOnSpan(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Standard, non-sensitive request attributes known before the channel is
 * resolved. `eve.channel.name` / `eve.channel.kind` are attached later by
 * the caller once the matching channel is known. Never records session
 * ids, tokens, auth or cookie headers, bodies, or query parameters.
 */
function baseAttributes(request: Request, routeKey: string): Attributes {
  const attributes: Attributes = {
    "http.request.method": request.method,
    "http.route": routeTemplate(routeKey),
  };

  const url = parseRequestUrl(request.url);
  if (url !== undefined) {
    attributes["url.scheme"] = url.protocol.replace(/:$/, "");
    attributes["server.address"] = url.hostname;
  }

  return attributes;
}

/**
 * Extracts the path template from a `"METHOD /path/:param"` route key. The
 * OTel HTTP convention keeps `http.route` free of the method so route
 * facets align with other server spans; the method lives in
 * `http.request.method` and the full key remains the span name.
 */
function routeTemplate(routeKey: string): string {
  const separator = routeKey.indexOf(" ");
  return separator === -1 ? routeKey : routeKey.slice(separator + 1);
}

function parseRequestUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(rawUrl);
  } catch {
    return undefined;
  }
}
