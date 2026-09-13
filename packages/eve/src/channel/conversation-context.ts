import type { RunInput } from "#channel/types.js";
import { resolveAudience } from "#channel/audience.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import type { ConversationContext, ConversationEnvironment } from "#shared/conversation-context.js";

export function buildConversationContext(
  run: RunInput,
  environment: ConversationEnvironment,
): ConversationContext {
  const auth = run.audienceAuth ?? run.auth;
  const projection = buildChannelInstrumentationProjection({
    adapter: run.adapter,
    channelName: run.channelName,
  });
  const channel = {
    kind: normalizeInstrumentationChannelKind(projection.kind),
    name: run.channelName,
  };
  const originAudience = run.parentTraceContext?.forwardedTracePolicy?.originAudience;
  const audience =
    originAudience ??
    run.inheritedConversation?.audience ??
    resolveAudience(run.adapter, {
      state: run.adapter.state,
      auth,
      channel,
      mode: run.mode,
      environment,
    });

  return {
    audience,
    channel,
    environment,
    mode: run.mode,
    principalType: auth?.principalType ?? "anonymous",
  };
}
