import type { SessionTraceContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import { readForwardedAudienceBaggage } from "#protocol/baggage.js";
import type { AgentInvocationTrace } from "#protocol/agent-invocation-trace.js";
import {
  FAIL_CLOSED_FORWARDED_TRACE_ASSERTION,
  formatTraceContentCeiling,
} from "#shared/forwarded-trace-policy.js";

const log = createLogger("eve.channel");

/** Resolves trace policy only after the route has authenticated a trusted forwarder. */
export function resolveInboundForwardedTrace(input: {
  readonly acceptedForwarder: boolean;
  readonly baggage: string | null;
  readonly extensionPolicy: AgentInvocationTrace["forwardedTracePolicy"];
  readonly forwarderId: string;
  readonly parentTraceContext?: SessionTraceContext;
}): {
  readonly acceptedPolicy: AgentInvocationTrace["forwardedTracePolicy"];
  readonly parentTraceContext?: SessionTraceContext;
} {
  const assertion =
    input.parentTraceContext === undefined ? "absent" : readForwardedAudienceBaggage(input.baggage);
  const acceptsLegacyPolicy =
    input.acceptedForwarder &&
    input.parentTraceContext !== undefined &&
    (input.parentTraceContext.traceFlags & 1) === 1;
  const acceptedPolicy =
    input.acceptedForwarder && input.extensionPolicy !== undefined
      ? input.extensionPolicy
      : !acceptsLegacyPolicy
        ? undefined
        : typeof assertion === "object"
          ? assertion
          : assertion === "malformed"
            ? FAIL_CLOSED_FORWARDED_TRACE_ASSERTION
            : undefined;

  if (assertion === "malformed") {
    log.warn("using metadata-only policy for malformed forwarded audience baggage", {
      forwarder: input.forwarderId,
    });
  } else if (typeof assertion === "object") {
    if (acceptedPolicy !== undefined) {
      log.info("accepted forwarded trace policy", {
        audience: assertion.originAudience,
        ceiling: formatTraceContentCeiling(assertion.ceiling),
        forwarder: input.forwarderId,
      });
    } else {
      log.warn("ignoring legacy forwarded trace policy without an accepted sampled principal", {
        forwarder: input.forwarderId,
      });
    }
  }

  return {
    acceptedPolicy,
    parentTraceContext:
      acceptedPolicy === undefined || input.parentTraceContext === undefined
        ? input.parentTraceContext
        : { ...input.parentTraceContext, forwardedTracePolicy: acceptedPolicy },
  };
}
