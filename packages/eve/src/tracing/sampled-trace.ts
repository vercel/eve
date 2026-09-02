export { resolveTracePolicy, resolveTracePolicyDecision } from "#shared/trace-policy.js";

// W3C sampled flag; written as a literal so this module stays out of the
// vendored OTel chunk, which the workflow driver bundle cannot include.
const TRACE_FLAGS_SAMPLED = 0x01;

export function isSampledTrace(context: { readonly traceFlags: number }): boolean {
  return (context.traceFlags & TRACE_FLAGS_SAMPLED) === TRACE_FLAGS_SAMPLED;
}
