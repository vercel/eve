import type { RunInput, SessionAuthContext } from "#channel/types.js";
import { resolveAudience } from "#channel/audience.js";
import { resolveSpace } from "#channel/space.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import {
  resolveConversationContext,
  type AudienceCaller,
  type ConversationContext,
  type ConversationEnvironment,
} from "#shared/conversation-context.js";
import { readForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";

type ConversationSource =
  | RunInput
  | (Pick<RunInput, "adapter" | "auth"> &
      Partial<
        Pick<
          RunInput,
          "audienceAuth" | "channelName" | "inheritedConversation" | "parentTraceContext"
        >
      >);

export function sessionOwnerAuth(
  run: Pick<RunInput, "auth"> & Partial<Pick<RunInput, "audienceAuth">>,
): SessionAuthContext | null {
  return Object.hasOwn(run, "audienceAuth") ? (run.audienceAuth ?? null) : run.auth;
}

export function buildConversationContext(
  run: ConversationSource,
  environment: ConversationEnvironment,
): ConversationContext {
  const auth = sessionOwnerAuth(run);
  const projection = buildChannelInstrumentationProjection({
    adapter: run.adapter,
    channelName: run.channelName,
  });
  const channel = {
    kind: normalizeInstrumentationChannelKind(projection.kind),
    name: run.channelName,
  };
  const inherited = run.inheritedConversation;
  const forwardedTracePolicy = readForwardedTraceAssertion(
    run.parentTraceContext?.forwardedTracePolicy,
  );
  const audience =
    forwardedTracePolicy?.originAudience ??
    inherited?.audience ??
    resolveAudience(run.adapter, {
      state: run.adapter.state,
      caller: toAudienceCaller(auth),
      channel,
      environment,
    });

  const space = inherited === undefined ? resolveSpace(run.adapter) : inherited.space;

  return {
    ...resolveConversationContext(undefined, {
      channelKind: projection.kind,
      environment,
      forwardedTracePolicy,
      principalType: auth?.principalType,
    }),
    audience,
    channel,
    ...(space !== undefined && { space }),
  };
}

export function toAudienceCaller(auth: SessionAuthContext | null | undefined): AudienceCaller {
  if (auth === null || auth === undefined || auth.principalType === "anonymous") {
    return { type: "anonymous" };
  }
  return {
    type: "principal",
    principal: {
      attributes: auth.attributes,
      authenticator: auth.authenticator,
      kind: auth.principalType,
    },
  };
}
