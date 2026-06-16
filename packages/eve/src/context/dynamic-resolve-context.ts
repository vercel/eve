import type { ModelMessage } from "ai";

import type { DynamicResolveContext } from "#shared/dynamic-tool-definition.js";
import type { AlsContext } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  SessionIdKey,
  InitiatorAuthKey,
  ContinuationTokenKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAdapterKind } from "#channel/adapter.js";

type ReadableContext = Pick<AlsContext, "get">;

/**
 * Builds the {@link DynamicResolveContext} from the active ALS context.
 *
 * Shared by all three dynamic lifecycle dispatchers (tools, skills,
 * instructions) so resolver handlers receive a consistent context shape.
 */
export function buildResolveContext(
  ctx: ReadableContext,
  messages: readonly ModelMessage[],
): DynamicResolveContext {
  const sessionId = ctx.get(SessionIdKey) ?? "";
  const currentAuth = ctx.get(AuthKey) ?? null;
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const channelAdapter = ctx.get(ChannelKey);
  const continuationToken = ctx.get(ContinuationTokenKey);
  const channelInstrumentation = ctx.get(ChannelInstrumentationKey);

  return {
    session: {
      id: sessionId,
      auth: {
        current: currentAuth,
        initiator: initiatorAuth,
      },
    },
    channel: {
      kind: channelAdapter !== undefined ? getAdapterKind(channelAdapter) : undefined,
      continuationToken,
      metadata: channelInstrumentation?.metadata,
    },
    messages,
  };
}
