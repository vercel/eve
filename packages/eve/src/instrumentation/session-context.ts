import type { AlsContext } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  ModeKey,
  ParentSessionKey,
  ParentTraceContextKey,
  AuthKey,
  SessionCallbackKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import {
  ConversationContextKey,
  UNKNOWN_CONVERSATION_CONTEXT,
  type ConversationContext,
} from "#shared/conversation-context.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
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
  const conversation =
    context.get(ConversationContextKey) ??
    ({
      ...UNKNOWN_CONVERSATION_CONTEXT,
      audience:
        context.get(ParentTraceContextKey)?.forwardedTracePolicy?.originAudience ?? "unknown",
      channel: {
        kind: normalizeInstrumentationChannelKind(instrumentation?.kind),
      },
      environment: resolveInstrumentationEnvironment(),
      mode: context.get(ModeKey) ?? "conversation",
      principalType: context.get(AuthKey)?.principalType ?? "anonymous",
    } satisfies ConversationContext);
  return {
    audience: conversation.audience,
    channel,
    conversation,
    context,
    forwardedTracePolicy: readForwardedTraceAssertion(traceSeed?.forwardedTracePolicy),
    instrumentation,
    parent,
    parentLineage: resolveParentLineage(parent, channel, context.get(SessionCallbackKey)),
    parentTraceContext: context.get(ParentTraceContextKey),
    principals: readInstrumentationPrincipals(context, conversation, traceSeed?.decision),
    traceSeed,
  };
}
