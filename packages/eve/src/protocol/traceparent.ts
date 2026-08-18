export interface TraceparentContext {
  readonly isRemote?: boolean;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;

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

function validId(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/iu.test(value) && !/^0+$/u.test(value);
}
