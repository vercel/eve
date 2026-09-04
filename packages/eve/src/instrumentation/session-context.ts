import type { AlsContext } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  ParentCallIdKey,
  ParentSessionKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import { resolveParentLineage } from "#instrumentation/parent-lineage.js";
import { readInstrumentationPrincipals } from "#instrumentation/principal-summary.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  readForwardedTraceAssertion,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

export function readInstrumentationSessionContext(context: AlsContext) {
  const storedTraceSeed = context.get(SessionTraceSeedKey);
  const resolvedTraceState = resolveForwardedTraceSeed(storedTraceSeed);
  const traceSeed =
    storedTraceSeed === undefined || resolvedTraceState === undefined
      ? undefined
      : { ...storedTraceSeed, ...resolvedTraceState };
  const parent = context.get(ParentSessionKey);
  const channel = context.get(ChannelKey);
  const instrumentation = context.get(ChannelInstrumentationKey);
  const audience = normalizeChannelAudience(instrumentation?.metadata.audience);
  return {
    audience,
    channel,
    context,
    forwardedTracePolicy: readForwardedTraceAssertion(traceSeed?.forwardedTracePolicy),
    instrumentation,
    parent,
    parentLineage: resolveParentLineage(parent, channel, context.get(ParentCallIdKey)),
    parentTraceContext: context.get(ParentTraceContextKey),
    principals: readInstrumentationPrincipals(context, audience),
    traceSeed,
  };
}
