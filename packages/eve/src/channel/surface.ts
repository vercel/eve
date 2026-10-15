// How built-in channels show a session. Its events mean the same on every platform: the agent
// works, replies, asks people, signs them in, and fails. A channel says how its platform shows
// each, as a `ChannelSurface`, and `surfaceEvents` makes its event handlers from that; a channel
// adds or replaces handlers for what only its platform does.

import {
  requestBatchOf,
  requestSettlementOf,
  type Interaction,
  type RequestBatch,
  type RequestSettlement,
} from "#channel/interaction-prompts.js";
import { promptQueue, type PromptQueueState } from "#channel/prompt-queue.js";
import { settleSignIn, showSignIn, type SignInSurface } from "#channel/sign-in.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type {
  ChannelEventContext,
  ChannelEventOf,
  CommittedLine,
} from "#public/definitions/channel.js";
import { failureNotice, replyTextOf } from "#public/channels/reply.js";

/** What a channel can do in its conversation, in its platform's terms. */
export interface ChannelSurface<TChannel> {
  /** Shows the agent working. */
  typing?(channel: TChannel): Promise<void>;
  /** Posts text in the conversation: a reply, or a failure notice. */
  post(channel: TChannel, text: string): Promise<unknown>;
  /** What a person starts after the session fails: "message", "comment". */
  readonly restart: string;
  /** How the platform asks people. */
  readonly requests: ButtonRequests<TChannel> | TextRequests<TChannel>;
  signIns(channel: TChannel): SignInSurface;
}

/** A platform with buttons: it shows a commit's requests at once, and marks each as it settles. */
export interface ButtonRequests<TChannel> {
  show(channel: TChannel, request: Interaction, batch: RequestBatch): Promise<void>;
  /** Called for every request that settles; one the channel didn't show it ignores. */
  settle(channel: TChannel, settlement: RequestSettlement): Promise<void>;
}

/** A platform with text alone: a reply answers the request it sees, so it sees one at a time. */
export interface TextRequests<TChannel> {
  /** Shows the request a typed reply answers now; `false` when it couldn't, to try again. */
  showOne(channel: TChannel, request: Interaction): Promise<boolean | void>;
}

type Handler<T extends SessionEvent["type"], TChannel> = (
  event: ChannelEventOf<T>,
  ctx: ChannelEventContext<TChannel>,
) => Promise<void>;

export interface SurfaceEvents<TChannel> {
  /** A text channel's: shows the request a typed reply answers now, as it changes. */
  readonly committed?: (line: CommittedLine, ctx: ChannelEventContext<TChannel>) => Promise<void>;
  readonly "turn.started"?: Handler<"turn.started", TChannel>;
  readonly "call.requested"?: Handler<"call.requested", TChannel>;
  readonly "interaction.opened": Handler<"interaction.opened", TChannel>;
  readonly "interaction.settled": Handler<"interaction.settled", TChannel>;
  readonly "content.completed": Handler<"content.completed", TChannel>;
  readonly "turn.settled": Handler<"turn.settled", TChannel>;
  readonly "session.ended": Handler<"session.ended", TChannel>;
}

/** The event handlers that show a session on `surface`. */
export function surfaceEvents<TChannel extends { readonly state: object }>(
  surface: ChannelSurface<TChannel>,
): SurfaceEvents<TChannel> {
  const { requests } = surface;
  // A text channel's state keeps which request it showed.
  const queue =
    "showOne" in requests
      ? (promptQueue<TChannel & { state: PromptQueueState }>(requests.showOne) as (
          line: CommittedLine,
          ctx: ChannelEventContext<TChannel>,
        ) => Promise<void>)
      : undefined;
  const { typing } = surface;
  const working =
    typing === undefined
      ? undefined
      : async (_event: unknown, { channel }: ChannelEventContext<TChannel>) => typing(channel);
  const post = async (channel: TChannel, text: string | undefined) => {
    if (text !== undefined) await surface.post(channel, text);
  };
  return {
    ...(working !== undefined && { "call.requested": working, "turn.started": working }),
    ...(queue !== undefined && { committed: queue }),
    async "interaction.opened"(event, ctx) {
      const { channel, view } = ctx;
      if ("show" in requests) {
        const batch = requestBatchOf(view, event.data);
        for (const request of batch?.requests ?? []) await requests.show(channel, request, batch!);
      }
      await showSignIn(view, event.data.interactionId, surface.signIns(channel));
    },
    // Covers every way a request ends: a press, a typed answer, or a withdrawal.
    async "interaction.settled"(event, ctx) {
      const { channel, view } = ctx;
      if ("settle" in requests) {
        const settlement = requestSettlementOf(view, event.data);
        if (settlement !== undefined) await requests.settle(channel, settlement);
      }
      await settleSignIn(view, event.data, surface.signIns(channel));
    },
    async "content.completed"({ data }, { channel }) {
      await post(channel, replyTextOf(data));
    },
    async "turn.settled"({ data }, { channel }) {
      await post(channel, failureNotice(data, "turn"));
    },
    async "session.ended"({ data }, { channel }) {
      await post(channel, failureNotice(data, { restart: surface.restart }));
    },
  };
}
