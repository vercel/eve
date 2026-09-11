import { createTraceState, type TraceState } from "#compiled/@opentelemetry/api/index.js";

export interface TraceparentContext {
  readonly isRemote?: boolean;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;
const EVE_TRACESTATE_KEY = "eve";
const EVE_DISPATCH_PARENT_PATTERN = /^([0-9a-f]{16})$/u;
const MAX_TRACESTATE_ENTRIES = 32;
const MAX_TRACESTATE_LENGTH = 512;

/** Formats a W3C version-00 traceparent, or omits an invalid context. */
export function formatTraceparent(context: TraceparentContext | undefined): string | undefined {
  if (
    context === undefined ||
    !validId(context.traceId, 32) ||
    !validId(context.spanId, 16) ||
    !Number.isInteger(context.traceFlags) ||
    context.traceFlags < 0 ||
    context.traceFlags > 0xff
  ) {
    return undefined;
  }
  return `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${context.traceFlags.toString(16).padStart(2, "0")}`;
}

/** Parses a W3C version-00 traceparent without rejecting the containing request. */
export function parseTraceparent(value: string | null): TraceparentContext | undefined {
  if (value === null) return undefined;
  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (match === null) return undefined;
  const traceId = match[1]!.toLowerCase();
  const spanId = match[2]!.toLowerCase();
  if (!validId(traceId, 32) || !validId(spanId, 16)) return undefined;
  return {
    isRemote: true,
    spanId,
    traceFlags: Number.parseInt(match[3]!, 16),
    traceId,
  };
}

/**
 * Restores the eve caller span preserved in W3C `tracestate`.
 *
 * `traceparent` remains the immediate HTTP parent, so its trace identity and
 * flags stay authoritative while eve's vendor entry supplies the earlier
 * semantic caller span ID.
 */
export function readAgentDispatchTraceContext(
  value: string | null,
  transport: TraceparentContext | undefined,
): TraceparentContext | undefined {
  if (value === null || transport === undefined) return undefined;
  const encoded = createTraceState(value).get(EVE_TRACESTATE_KEY);
  const match = encoded === undefined ? null : EVE_DISPATCH_PARENT_PATTERN.exec(encoded);
  const spanId = match?.[1];
  return spanId === undefined || !validId(spanId, 16) ? undefined : { ...transport, spanId };
}

/**
 * Writes eve's prior-parent vendor entry while preserving other valid
 * `tracestate` members and W3C size limits.
 */
export function writeAgentDispatchTracestate(
  value: string | undefined,
  context: TraceparentContext | undefined,
): string | undefined {
  const state = createTraceState(value);
  if (context === undefined || formatTraceparent(context) === undefined) {
    return boundedTracestate(state.unset(EVE_TRACESTATE_KEY));
  }
  return boundedTracestate(state.set(EVE_TRACESTATE_KEY, context.spanId.toLowerCase()));
}

function boundedTracestate(initial: TraceState): string | undefined {
  let state = initial;
  let serialized = state.serialize();
  let entries = serialized.split(",").filter(Boolean);
  while (entries.length > MAX_TRACESTATE_ENTRIES || serialized.length > MAX_TRACESTATE_LENGTH) {
    const last = entries.at(-1);
    if (last === undefined) return undefined;
    state = state.unset(last.slice(0, last.indexOf("=")));
    serialized = state.serialize();
    entries = serialized.split(",").filter(Boolean);
  }
  return serialized || undefined;
}

function validId(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/iu.test(value) && !/^0+$/u.test(value);
}
