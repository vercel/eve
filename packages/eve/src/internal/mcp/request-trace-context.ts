import {
  createTraceState,
  trace,
  TraceFlags,
  type Context,
  type SpanContext,
} from "#compiled/@opentelemetry/api/index.js";

import { isObject } from "#shared/guards.js";

const MAX_TRACESTATE_LENGTH = 512;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

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
