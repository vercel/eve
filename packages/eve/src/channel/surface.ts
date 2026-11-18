import {
  requestBatchOf,
  requestSettlementOf,
  type Interaction,
  type RequestBatch,
  type RequestSettlement,
} from "#channel/interaction-prompts.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import { promptQueue, type PromptQueueState } from "#channel/prompt-queue.js";
import { settleSignIn, showSignIn, type SignInSurface } from "#channel/sign-in.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type {
  ChannelEventContext,
  ChannelEventOf,
  CommittedLine,
} from "#public/definitions/channel.js";
import { failureNotice, replyTextOf } from "#public/channels/reply.js";

export interface ChannelSurface<TChannel> {
  typing?(channel: TChannel): Promise<void>;
  post(channel: TChannel, text: string): Promise<unknown>;
  readonly restart: string;
  readonly requests: ButtonRequests<TChannel> | TextRequests<TChannel>;
  signIns(channel: TChannel): SignInSurface;
}

export interface ButtonRequests<TChannel> {
  show(channel: TChannel, request: Interaction, batch: RequestBatch): Promise<void>;
  settle(channel: TChannel, settlement: RequestSettlement): Promise<void>;
}

export interface TextRequests<TChannel> {
  showOne(channel: TChannel, request: Interaction): Promise<boolean | void>;
}

type Handler<T extends SessionEvent["type"], TChannel> = (
  event: ChannelEventOf<T>,
  ctx: ChannelEventContext<TChannel>,
) => Promise<void>;

export interface SurfaceEvents<TChannel> {
  readonly committed?: (line: CommittedLine, ctx: ChannelEventContext<TChannel>) => Promise<void>;
  readonly "turn.started"?: Handler<"turn.started", TChannel>;
  readonly "call.requested"?: Handler<"call.requested", TChannel>;
  readonly "interaction.opened": Handler<"interaction.opened", TChannel>;
  readonly "interaction.settled": Handler<"interaction.settled", TChannel>;
  readonly "content.completed": Handler<"content.completed", TChannel>;
  readonly "turn.settled": Handler<"turn.settled", TChannel>;
  readonly "session.ended": Handler<"session.ended", TChannel>;
}

export function surfaceEvents<TChannel extends { readonly state: object }>(
  surface: ChannelSurface<TChannel>,
): SurfaceEvents<TChannel> {
  const { requests } = surface;
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
      const { channel } = ctx;
      const view = sessionTables(ctx.view);
      if ("show" in requests) {
        const batch = requestBatchOf(view, event.data);
        for (const request of batch?.requests ?? []) await requests.show(channel, request, batch!);
      }
      await showSignIn(view, event.data.interactionId, surface.signIns(channel));
    },
    async "interaction.settled"(event, ctx) {
      const { channel } = ctx;
      const view = sessionTables(ctx.view);
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
