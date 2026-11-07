import { toCard, toPartialCard, type CardLimits } from "@json-render/chat";
import type { Spec } from "@json-render/core";
import { parsePartialJson } from "ai";
import {
  cardToBlocks,
  cardToFallbackText,
  defineSlackRenderer,
  type SlackEventContext,
  type SlackRenderer,
} from "eve/channels/slack";

import { CARD_TOOL, cardSpecSchema, SLACK_CARD_LIMITS } from "./card-spec";

export interface SlackCardRendererOptions {
  /** Minimum time between edits while a card streams. Defaults to 500 ms, Chat SDK's interval. */
  readonly updateIntervalMs?: number;
  /** Per-message limits the final card must fit. Defaults to Slack's. */
  readonly limits?: CardLimits;
}

type CardElement = ReturnType<typeof toCard>;
// json-render types cards with Chat SDK's declarations; eve declares its own copy of the same data.
type SlackCard = Parameters<typeof cardToBlocks>[0];
const asSlackCard = (card: CardElement) => card as SlackCard;

/** The Slack message a card call posted, kept in channel state so a later step can edit it. */
interface PostedCard {
  readonly ts: string;
  /** Serialized blocks last sent, to skip edits that change nothing. */
  readonly sent: string;
}

interface CardState {
  jsonRenderCards?: Record<string, PostedCard>;
}

/** Streaming input per call. Progress records are not replayed, so this lives in memory. */
interface StreamingCall {
  text: string;
  lastUpdateMs: number;
}

/**
 * A Slack renderer that shows each `card` tool call as a native Block Kit message: posted as soon
 * as the model has written the card's root, edited as elements stream in, and replaced with the
 * validated card once the call's input is complete. A call that fails validation removes its
 * partial message, so only the model's corrected retry stays in the thread.
 */
export function slackCardRenderer(options: SlackCardRendererOptions = {}): SlackRenderer {
  const interval = options.updateIntervalMs ?? 500;
  const limits = options.limits ?? SLACK_CARD_LIMITS;
  const streaming = new Map<string, StreamingCall>();

  return defineSlackRenderer({
    events: {
      async "call.input"(event, ctx, next) {
        const { callId, delta, name } = event.data;
        let call = streaming.get(callId);
        if (call === undefined) {
          // Only the announcing record carries the name.
          if (name !== CARD_TOOL) return next();
          call = { text: "", lastUpdateMs: 0 };
          streaming.set(callId, call);
        }
        call.text += delta;
        const now = Date.now();
        if (now - call.lastUpdateMs < interval) return;
        call.lastUpdateMs = now;
        const { value } = await parsePartialJson(call.text);
        if (value === undefined || value === null || typeof value !== "object") return;
        const partial = safely(() => toPartialCard(value as Partial<Spec>));
        if (partial && hasContent(partial)) await show(ctx.channel, callId, partial);
      },

      async "call.requested"(event, ctx, next) {
        const { callId, capability, input } = event.data;
        if (capability.name !== CARD_TOOL) return next();
        streaming.delete(callId);
        // An invalid spec keeps its partial message until the call fails and removes it.
        const spec = cardSpecSchema.safeParse(input);
        const card = spec.success ? safely(() => toCard(spec.data, { limits })) : null;
        if (card) await show(ctx.channel, callId, card);
        return next();
      },

      async "call.settled"(event, ctx, next) {
        const { callId, outcome } = event.data;
        const cards = stateOf(ctx.channel).jsonRenderCards;
        const posted = cards?.[callId];
        if (posted !== undefined) {
          delete cards![callId];
          if (outcome !== "completed") await remove(ctx.channel, posted.ts);
        }
        return next();
      },
    },
  });
}

async function show(channel: SlackEventContext, callId: string, card: CardElement): Promise<void> {
  const state = stateOf(channel);
  const blocks = cardToBlocks(asSlackCard(card));
  const sent = JSON.stringify(blocks);
  const posted = state.jsonRenderCards?.[callId];
  if (posted?.sent === sent) return;
  if (posted === undefined) {
    const message = await channel.thread.post(asSlackCard(card));
    if (!message.id) return;
    state.jsonRenderCards = { ...state.jsonRenderCards, [callId]: { ts: message.id, sent } };
    return;
  }
  const response = await channel.slack.request("chat.update", {
    channel: channel.slack.channelId,
    ts: posted.ts,
    blocks,
    text: cardToFallbackText(asSlackCard(card)),
  });
  if (response.ok === true) {
    state.jsonRenderCards = { ...state.jsonRenderCards, [callId]: { ts: posted.ts, sent } };
  }
}

async function remove(channel: SlackEventContext, ts: string): Promise<void> {
  await channel.slack.request("chat.delete", { channel: channel.slack.channelId, ts });
}

function stateOf(channel: SlackEventContext): CardState {
  return channel.state as CardState;
}

function hasContent(card: CardElement): boolean {
  return Boolean(card.title || card.subtitle || card.imageUrl || card.children.length > 0);
}

function safely<T>(build: () => T): T | null {
  try {
    return build();
  } catch {
    return null;
  }
}
