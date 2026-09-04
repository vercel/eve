import type { SessionTraceSeed } from "#context/keys.js";
import { childSessionTraceKey } from "#instrumentation/lifecycle.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";
import type { ForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";

export function allocateChildSessionTraceSeed(input: {
  readonly callId: string;
  readonly forwardedTracePolicy?: ForwardedTraceAssertion;
  readonly sessionId: string;
  readonly turnId: string;
}): SessionTraceSeed | undefined {
  const runtime = getInstrumentationRuntime();
  if (runtime?.prepareSessionTrace === undefined || runtime.idGenerator === undefined) {
    return undefined;
  }
  const key = childSessionTraceKey(input.sessionId, input.turnId, input.callId);
  const seed: SessionTraceSeed = {
    spanId: runtime.idGenerator.deriveSpanId(`${key}:root`),
    traceFlags: 0,
    traceId: runtime.idGenerator.deriveTraceId(key),
  };
  return input.forwardedTracePolicy === undefined
    ? seed
    : { ...seed, forwardedTracePolicy: input.forwardedTracePolicy };
}
