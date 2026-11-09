import type { SessionTraceSeed } from "#context/keys.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import {
  readInstrumentationDecision,
  type InstrumentationDecision,
} from "#shared/instrumentation-decision.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#shared/trace-policy.js";
import type { OtelHarnessSettings } from "#tracing/eve/otel-declaration.js";

export function resolveInstrumentationTraceDecision(
  settings: OtelHarnessSettings | undefined,
  agentName: string,
  conversation: ConversationContext,
  traceSeed: SessionTraceSeed | undefined,
  persisted: InstrumentationDecision | undefined,
): InstrumentationDecision | undefined {
  if (settings === undefined) return undefined;
  if (traceSeed?.decision !== undefined) return readInstrumentationDecision(traceSeed.decision);
  if (persisted !== undefined) return persisted;
  if (traceSeed !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(traceSeed), conversation);
  }
  return resolveTracePolicy(settings.tracePolicy, { agentName, ...conversation });
}
