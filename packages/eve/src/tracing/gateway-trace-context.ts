import {
  context as otelContext,
  propagation,
  trace,
  type TextMapSetter,
} from "#compiled/@opentelemetry/api/index.js";

import { stripEveTraceBaggage } from "#protocol/baggage.js";
import { isTracingSuppressed } from "#tracing/suppress-tracing.js";

const traceContextSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export function createGatewayTraceContextHeaders(): Record<string, string> | undefined {
  const activeContext = otelContext.active();
  if (isTracingSuppressed(activeContext) || trace.getSpan(activeContext) === undefined) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  propagation.inject(activeContext, headers, traceContextSetter);
  stripEveTraceBaggage(headers);
  return Object.keys(headers).length === 0 ? undefined : headers;
}
