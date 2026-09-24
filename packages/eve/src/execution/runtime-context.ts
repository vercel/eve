import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  ChannelDeliveryKey,
  ChannelRequestIdKey,
  ContinuationHookTokensKey,
  ContinuationTokenKey,
  ConversationIdKey,
  DelegatedSessionKey,
  DynamicSubagentAgentConfigKey,
  InitiatorAuthKey,
  ModeKey,
  ParentSessionKey,
  ParentTraceContextKey,
  ActivityObserverKey,
  ScheduleIdKey,
  SessionCallbackKey,
  SessionTitleKey,
} from "#context/keys.js";
import { deriveSessionTitle } from "#execution/eve-workflow-attributes.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { readConversationId } from "#tracing/conversation-context.js";
import { buildConversationContext } from "#channel/conversation-context.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";

/**
 * Builds the bootstrap {@link ContextContainer} for one run.
 */
export function buildRunContext(input: {
  readonly bundle: CompiledBundle;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly run: RunInput;
}): ContextContainer {
  const { bundle, run } = input;
  const ctx = new ContextContainer();
  const auth: SessionAuthContext | null = run.auth;
  const conversationId = readConversationId(run.conversationId);
  if (conversationId !== undefined) ctx.set(ConversationIdKey, conversationId);

  ctx.set(BundleKey, bundle);
  setChannelContext(ctx, run.adapter, { channelName: run.channelName });
  ctx.set(
    ConversationContextKey,
    buildConversationContext(run, resolveInstrumentationEnvironment()),
  );
  if (run.parent === undefined) {
    const title = deriveSessionTitle(run.title ?? run.input.message);
    if (title !== undefined) ctx.set(SessionTitleKey, title);
  }

  if (run.channelMetadata !== undefined) {
    const existing = ctx.get(ChannelInstrumentationKey);
    ctx.set(ChannelInstrumentationKey, {
      channelType: existing?.channelType ?? run.channelMetadata.channelType,
      kind: existing?.kind ?? run.channelMetadata.kind,
      metadata: run.channelMetadata.metadata,
    });
  }

  if (run.continuationToken !== undefined) {
    ctx.set(ContinuationTokenKey, run.continuationToken);
    ctx.set(ContinuationHookTokensKey, [run.continuationToken]);
  }
  ctx.set(ModeKey, run.mode);
  ctx.set(AuthKey, auth);
  if (run.initiatorAuth !== undefined || run.input.message !== undefined) {
    ctx.set(InitiatorAuthKey, run.initiatorAuth ?? auth);
  }

  if (input.dynamicSubagentAgentConfig !== undefined) {
    ctx.set(DynamicSubagentAgentConfigKey, input.dynamicSubagentAgentConfig);
  }

  if (run.capabilities !== undefined) {
    ctx.set(CapabilitiesKey, run.capabilities);
  }

  if (run.requestId !== undefined) {
    ctx.set(ChannelRequestIdKey, run.requestId);
  }

  const scheduleId = contextStorage.getStore()?.get(ScheduleIdKey);
  if (scheduleId !== undefined) {
    ctx.set(ScheduleIdKey, scheduleId);
  }

  if (run.delivery !== undefined) {
    ctx.set(ChannelDeliveryKey, run.delivery);
  }

  if (run.callback !== undefined) {
    ctx.set(SessionCallbackKey, run.callback);
  }
  if (run.callback !== undefined || run.parent !== undefined) {
    ctx.set(DelegatedSessionKey, true);
  }
  if (run.activityObserver !== undefined) {
    ctx.set(ActivityObserverKey, run.activityObserver);
  }

  if (run.parent !== undefined) {
    ctx.set(ParentSessionKey, run.parent);
  }

  if (run.parentTraceContext !== undefined) {
    ctx.set(ParentTraceContextKey, run.parentTraceContext);
  }

  // `run.limits` deliberately never enters the context: inherited limits ride
  // the typed workflow-entry payload into `createSessionStep` and live on the
  // session from then on.

  return ctx;
}
