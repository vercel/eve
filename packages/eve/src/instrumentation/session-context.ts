import type { AlsContext } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  ModeKey,
  ParentSessionKey,
  ParentTraceContextKey,
  AuthKey,
  ScheduleIdKey,
  SessionCallbackKey,
  SessionTitleKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import {
  ConversationContextKey,
  resolveConversationContext,
} from "#shared/conversation-context.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { resolveParentLineage } from "#instrumentation/parent-lineage.js";
import { readInstrumentationPrincipals } from "#instrumentation/principal-summary.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  readForwardedTraceAssertion,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";

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
  const forwardedTracePolicy = readForwardedTraceAssertion(traceSeed?.forwardedTracePolicy);
  const conversation = resolveConversationContext(context.get(ConversationContextKey), {
    channelKind: instrumentation?.kind,
    environment: resolveInstrumentationEnvironment(),
    forwardedTracePolicy,
    mode: context.get(ModeKey),
    principalType: context.get(AuthKey)?.principalType,
  });
  return {
    audience: conversation.audience,
    channel,
    conversation,
    context,
    forwardedTracePolicy,
    instrumentation,
    parent,
    parentLineage: resolveParentLineage(parent, channel, context.get(SessionCallbackKey)),
    parentTraceContext: context.get(ParentTraceContextKey),
    principals: readInstrumentationPrincipals(context, conversation, traceSeed?.decision),
    scheduleId: context.get(ScheduleIdKey),
    title: context.get(SessionTitleKey),
    traceSeed,
  };
}
