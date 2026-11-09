import { parsePartialJson } from "ai";

import { contextStorage } from "#context/container.js";
import { createLogger } from "#internal/logging.js";
import { EVE_CONTENT_KINDS, textOfPart } from "#protocol/session-events/catalog.js";
import type {
  ContentCompletedData,
  ContentDeltaData,
} from "#protocol/session-events/families/content.js";
import type { CardElement } from "#public/channels/slack/cards.js";
import type { ContentRendererDefinition } from "#public/definitions/content-renderer.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { declared } from "#runtime/types.js";

// How a channel draws reply parts of other kinds, such as a tool's card, with the agent's
// content renderers: a card that previews while the model writes it, edited as it streams and
// replaced by the finished part, or the part's text where there's no renderer.

const log = createLogger("channel.content-cards");

/** The minimum time between edits of a streaming card, as Chat SDK streams. */
const PREVIEW_INTERVAL_MS = 500;

/** The agent's renderer for `mediaType`, when the agent or one of its extensions has one. */
export function contentRendererFor(
  mediaType: string | undefined,
): ContentRendererDefinition | undefined {
  if (mediaType === undefined) return undefined;
  const agent = contextStorage.getStore()?.get(BundleKey)?.resolvedAgent;
  if (agent === undefined) return undefined;
  return declared(agent, "renderer").find((entry) => entry.renderer.mediaType === mediaType)
    ?.renderer;
}

/**
 * What a completed reply part posts as markdown in a channel that posts markdown: its renderer's
 * markdown, or else its text.
 */
export function replyMarkdownOf(part: ContentCompletedData): string | undefined {
  if (part.phase === "reply" && !EVE_CONTENT_KINDS.has(part.kind)) {
    const markdown = safely(part.mediaType, () =>
      contentRendererFor(part.mediaType)?.markdown?.(part.value),
    );
    if (typeof markdown === "string" && markdown.length > 0) return markdown;
  }
  return part.phase === "reply" ? textOfPart(part) : undefined;
}

/** How a channel posts, edits, and removes a card message. */
export interface CardMessages {
  /** Posts `card`, returning the message's id, or `undefined` when the platform gave none. */
  post(card: CardElement): Promise<string | undefined>;
  /** Replaces message `id` with `card`. */
  edit(id: string, card: CardElement): Promise<void>;
  remove(id: string): Promise<void>;
  /** Whether the channel can edit a posted message, so a card can preview while it streams. */
  readonly streams: boolean;
}

/** The card messages a channel posted for reply parts, kept in its state across steps. */
export interface ContentCardsState {
  contentCards?: Record<string, ShownCard> | null;
}

interface ShownCard {
  readonly messageId: string;
  /** The card last posted, serialized, so an edit that changes nothing is skipped. */
  readonly shown: string;
  readonly callId?: string;
}

/** A part's streaming preview. Progress records aren't replayed, so this lives in memory. */
interface Preview {
  readonly mediaType: string;
  readonly callId?: string;
  text: string;
  lastAtMs: number;
}

const previews = new Map<string, Preview>();

/**
 * Previews a reply part a renderer draws as the model writes it: posts a card once the partial
 * value renders, then edits it at most every {@link PREVIEW_INTERVAL_MS}. Returns whether the
 * delta belonged to such a part.
 */
export async function previewContentCard(
  messages: CardMessages,
  state: ContentCardsState,
  delta: ContentDeltaData,
): Promise<boolean> {
  let preview = previews.get(delta.partId);
  if (preview === undefined) {
    const { kind, mediaType } = delta;
    if (kind === undefined || EVE_CONTENT_KINDS.has(kind) || mediaType === undefined) return false;
    if (contentRendererFor(mediaType)?.card === undefined) return false;
    preview = {
      ...(delta.callId !== undefined && { callId: delta.callId }),
      lastAtMs: 0,
      mediaType,
      text: "",
    };
    previews.set(delta.partId, preview);
  }
  preview.text += delta.delta;
  if (!messages.streams) return true;
  const now = Date.now();
  if (now - preview.lastAtMs < PREVIEW_INTERVAL_MS) return true;
  preview.lastAtMs = now;
  const value = await partialValue(preview);
  if (value === undefined) return true;
  const card = renderCard(preview.mediaType, value, true);
  if (card !== null && hasContent(card)) {
    await show(messages, state, delta.partId, card, preview.callId);
  }
  return true;
}

/**
 * Shows a completed reply part as its renderer's card, posting it or replacing its preview.
 * Returns `false` when no renderer draws it, so the channel posts its text instead; a preview
 * the renderer can't finish is removed first.
 */
export async function showContentCard(
  messages: CardMessages,
  state: ContentCardsState,
  part: ContentCompletedData,
): Promise<boolean> {
  previews.delete(part.partId);
  const shown = state.contentCards?.[part.partId];
  const card =
    part.phase === "reply" && !EVE_CONTENT_KINDS.has(part.kind)
      ? renderCard(part.mediaType, part.value, false)
      : null;
  if (card === null) {
    if (shown !== undefined) {
      forget(state, part.partId);
      await messages.remove(shown.messageId);
    }
    return false;
  }
  await show(messages, state, part.partId, card, part.callId);
  forget(state, part.partId);
  return true;
}

/** Removes the previews of a call that settled without completing its part. */
export async function dropContentCards(
  messages: CardMessages,
  state: ContentCardsState,
  callId: string,
): Promise<void> {
  for (const [partId, preview] of previews) {
    if (preview.callId === callId) previews.delete(partId);
  }
  for (const [partId, shown] of Object.entries(state.contentCards ?? {})) {
    if (shown.callId !== callId) continue;
    forget(state, partId);
    await messages.remove(shown.messageId);
  }
}

async function show(
  messages: CardMessages,
  state: ContentCardsState,
  partId: string,
  card: CardElement,
  callId: string | undefined,
): Promise<void> {
  const serialized = JSON.stringify(card);
  const shown = state.contentCards?.[partId];
  if (shown?.shown === serialized) return;
  let messageId = shown?.messageId;
  if (messageId === undefined) messageId = await messages.post(card);
  else await messages.edit(messageId, card);
  if (messageId === undefined) return;
  state.contentCards = {
    ...state.contentCards,
    [partId]: { messageId, shown: serialized, ...(callId !== undefined && { callId }) },
  };
}

function forget(state: ContentCardsState, partId: string): void {
  if (state.contentCards?.[partId] === undefined) return;
  const { [partId]: _forgotten, ...rest } = state.contentCards;
  state.contentCards = Object.keys(rest).length === 0 ? null : rest;
}

async function partialValue(preview: Preview): Promise<unknown> {
  if (!preview.mediaType.endsWith("+json") && preview.mediaType !== "application/json") {
    return undefined;
  }
  const { value } = await parsePartialJson(preview.text);
  return value ?? undefined;
}

function renderCard(
  mediaType: string | undefined,
  value: unknown,
  partial: boolean,
): CardElement | null {
  const render = () => contentRendererFor(mediaType)?.card?.(value, { partial }) ?? null;
  if (!partial) return safely(mediaType, render) ?? null;
  // A partial value often fails a renderer's checks until more of it streams.
  try {
    return render();
  } catch {
    return null;
  }
}

function hasContent(card: CardElement): boolean {
  return Boolean(card.title || card.subtitle || card.imageUrl || card.children.length > 0);
}

/** A renderer that throws falls back to the part's text, as one that returns `null` does. */
function safely<T>(mediaType: string | undefined, render: () => T): T | undefined {
  try {
    return render();
  } catch (error) {
    log.warn("content renderer threw; showing the part's text", { error, mediaType });
    return undefined;
  }
}
