import {
  createTraceState,
  trace,
  TraceFlags,
  type Context,
  type SpanContext,
} from "#compiled/@opentelemetry/api/index.js";

import { isObject } from "#shared/guards.js";

/** W3C caps `tracestate` at 512 characters; a longer value is dropped whole. */
const MAX_TRACESTATE_LENGTH = 512;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/**
 * Adopts the W3C trace context an MCP client sends in a request's
 * `params._meta` as the parent of everything the request runs.
 *
 * Only `traceparent` and `tracestate` are read, and each is validated and
 * bounded; anything malformed leaves `parent` as it was. `baggage` is never
 * read: an MCP caller cannot choose eve's audience, session lineage, or
 * content capture by sending it. Every other value already on `parent`,
 * error-content policy included, is kept.
 */
export function withMcpRequestTraceContext(parent: Context, body: unknown): Context {
  if (!isObject(body) || Array.isArray(body) || !isObject(body.params)) return parent;
  const meta = body.params._meta;
  if (!isObject(meta)) return parent;
  const traceparent = meta.traceparent;
  if (typeof traceparent !== "string") return parent;
  const match = TRACEPARENT.exec(traceparent);
  if (match === null) return parent;
  const traceId = match[1];
  const spanId = match[2];
  const flags = match[3];
  if (traceId === undefined || spanId === undefined || flags === undefined) return parent;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return parent;

  const tracestate = meta.tracestate;
  const traceState =
    typeof tracestate === "string" &&
    tracestate.length > 0 &&
    tracestate.length <= MAX_TRACESTATE_LENGTH
      ? createTraceState(tracestate)
      : undefined;
  const spanContext: SpanContext = {
    isRemote: true,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    traceId,
  };
  if (traceState !== undefined) spanContext.traceState = traceState;
  const remote = trace.wrapSpanContext(spanContext);
  return trace.setSpan(parent, remote);
}
