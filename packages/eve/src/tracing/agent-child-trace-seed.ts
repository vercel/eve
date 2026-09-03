import type { SessionTraceContext } from "#channel/types.js";
import type { SessionTraceSeed } from "#context/keys.js";
import { childSessionTraceKey } from "#instrumentation/lifecycle.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";
import type { ForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";

export function allocateChildSessionTraceSeed(input: {
  readonly callId: string;
  readonly forwardedTracePolicy?: ForwardedTraceAssertion;
  readonly parentTraceContext?: SessionTraceContext;
  readonly sessionId: string;
  readonly turnId: string;
}): SessionTraceSeed | undefined {
  const runtime = getInstrumentationRuntime();
  if (runtime?.prepareSessionTrace === undefined || runtime.idGenerator === undefined) {
    return undefined;
  }
  const key = childSessionTraceKey(input.sessionId, input.turnId, input.callId);
  const derivedTraceId = runtime.idGenerator.deriveTraceId(key);
  const traceId =
    input.parentTraceContext === undefined
      ? derivedTraceId
      : distinctChildTraceId(derivedTraceId, input.parentTraceContext.traceId);
  const seed: SessionTraceSeed = {
    spanId: runtime.idGenerator.deriveSpanId(`${key}:root`),
    traceFlags: 0,
    traceId,
  };
  return input.forwardedTracePolicy === undefined
    ? seed
    : { ...seed, forwardedTracePolicy: input.forwardedTracePolicy };
}

function distinctChildTraceId(traceId: string, parentTraceId: string): string {
  if (traceId !== parentTraceId) return traceId;
  const lastDigit = traceId.at(-1);
  return `${traceId.slice(0, -1)}${lastDigit === "f" ? "e" : "f"}`;
}
