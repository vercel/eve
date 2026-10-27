import { getAdapterKind } from "#channel/adapter.js";
import type { ContextReader } from "#context/key.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  ParentSessionKey,
  SessionPredecessorKey,
} from "#context/keys.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import type { SessionFrame } from "#dynamic/definition.js";
import { currentView } from "#harness/session-machine/current.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { compactionThreshold } from "#harness/compaction/measure.js";
import { getEffectiveModelSelection } from "#reactions/kinds/model.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import { readReactionsState, sessionIdOf } from "./state.js";
import { latestTurn } from "./turn.js";

/** The channel the session's latest delivery came through. */
export function channelOf(ctx: ContextReader): SessionFrame["channel"] {
  const adapter = ctx.get(ChannelKey);
  const instrumentation = ctx.get(ChannelInstrumentationKey);
  return {
    continuationToken: ctx.get(ContinuationTokenKey),
    // An authored channel reads as `channel:<name>`, which its adapter kind doesn't carry.
    kind: normalizeInstrumentationChannelKind(
      instrumentation?.kind ?? (adapter === undefined ? undefined : getAdapterKind(adapter)),
    ),
    metadata: instrumentation?.metadata ?? {},
  };
}

/**
 * The session as of its latest commit, or as of the commit `at` the given view: what every
 * dynamic value and hook handler reads.
 */
export function sessionFrameOf(
  ctx: ContextReader,
  input: { readonly view?: SessionView; readonly at?: string } = {},
): SessionFrame {
  const conversation = ctx.get(ConversationContextKey);
  const parent = ctx.get(ParentSessionKey);
  const view = input.view ?? currentView(ctx);
  const at = input.at ?? readReactionsState(ctx).at ?? view.session.startedAt;
  return {
    channel: channelOf(ctx),
    ...(conversation !== undefined && { conversation }),
    now: new Date(at ?? 0),
    session: {
      auth: { current: ctx.get(AuthKey) ?? null, initiator: ctx.get(InitiatorAuthKey) ?? null },
      id: sessionIdOf(ctx),
      // A root session has no parent; none is made up for it.
      ...(parent !== undefined && { parent }),
      predecessor: ctx.get(SessionPredecessorKey),
      schedule: readSessionSchedule(ctx),
    },
    turn: latestTurn(view),
    view: snapshotOf(
      view,
      undefined,
      undefined,
      compactionThreshold(getEffectiveModelSelection(ctx)?.reference.contextWindowTokens),
    ),
  };
}
