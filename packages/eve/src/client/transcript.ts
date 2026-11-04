import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { UserPart } from "#protocol/session-events/envelope.js";

/** One user message or completed assistant message in a {@link TranscriptData}. */
export interface TranscriptMessage {
  readonly role: "assistant" | "user";
  readonly text: string;
}

/** A session's text conversation, as {@link transcriptOf} reads it. */
export interface TranscriptData {
  /** The messages of the session's current conversation, oldest first. */
  readonly messages: readonly TranscriptMessage[];
}

/** Options for {@link transcriptOf}. */
export interface TranscriptOptions {
  /**
   * Most recent messages kept; older ones are dropped as new ones arrive.
   * A positive integer. Unbounded when omitted.
   */
  readonly maxMessages?: number;
}

/**
 * A session's text conversation, from its stream: imported history, user message text, and
 * completed assistant text, oldest first.
 *
 * The user's text is what each consumed delivery carries, after the history it imported; the
 * assistant's is each completed reply part. When one line consumes several deliveries, their
 * history comes before their messages, as the model reads them. Reasoning, narration, tool calls
 * and results, attachments, interactions, and interrupted or unfinished output are left out.
 *
 * Only the session's current conversation is returned: the newest turn, or the one a later
 * context change selected, and the turns it follows back. A completed clear (`context.settled`
 * selecting nothing), or a reset that ended a stranded session, starts the transcript over, so
 * text the session no longer holds is never returned.
 *
 * @example
 * ```ts
 * import { transcriptOf } from "eve/client";
 * import { sessions } from "eve/server";
 *
 * const events = [];
 * for await (const event of sessions.attach(sessionId).stream({ follow: false })) events.push(event);
 * const { messages } = transcriptOf(events, { maxMessages: 40 });
 * ```
 *
 * @throws When `maxMessages` is not a positive integer.
 */
export function transcriptOf(
  events: Iterable<SessionStreamEvent>,
  options: TranscriptOptions = {},
): TranscriptData {
  const { maxMessages } = options;
  if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)) {
    throw new TypeError(
      `transcriptOf: "maxMessages" must be a positive integer; received ${String(maxMessages)}.`,
    );
  }
  // Each message keeps the turn it belongs to, so turns outside the conversation drop out.
  let entries: { readonly message: TranscriptMessage; readonly turnId: string | undefined }[] = [];
  const follows = new Map<string, string | null>();
  let latestTurnId: string | undefined;
  let selection: string | null | undefined;
  let resetDeliveryId: string | undefined;
  // Where the history of the deliveries the current line consumes goes: before their messages.
  let consumed: { readonly line: number | undefined; at: number } | undefined;
  const append = (message: TranscriptMessage, turnId: string | undefined) => {
    if (message.text.trim().length > 0) entries.push({ message, turnId });
  };
  for (const event of events) {
    const line = event.meta?.position?.line;
    if (event.type !== "delivery.consumed" || consumed?.line !== line) consumed = undefined;
    switch (event.type) {
      case "delivery.admitted":
        if (
          event.data.source !== undefined &&
          "control" in event.data.source &&
          event.data.source.control === "reset"
        )
          resetDeliveryId = event.data.deliveryId;
        break;
      case "turn.started":
        follows.set(event.data.turnId, event.data.follows);
        latestTurnId = event.data.turnId;
        selection = undefined;
        break;
      case "delivery.consumed": {
        const { turnId } = event.data;
        consumed ??= { at: entries.length, line };
        const history = (event.data.history ?? [])
          .filter(({ text }) => text.trim().length > 0)
          .map(({ role, text }) => ({ message: { role, text }, turnId }));
        entries.splice(consumed.at, 0, ...history);
        consumed.at += history.length;
        append({ role: "user", text: textOf(event.data.parts) }, turnId);
        break;
      }
      case "content.completed":
        if (
          event.data.kind === "text" &&
          event.data.phase === "reply" &&
          event.data.interrupted !== true &&
          typeof event.data.value === "string"
        )
          append({ role: "assistant", text: event.data.value }, event.scope?.turnId);
        break;
      case "context.settled":
        if (event.data.outcome !== "completed" || event.data.selects === undefined) break;
        if (event.data.selects === null) entries = [];
        selection = event.data.selects === null ? null : event.data.selects.turnId;
        break;
      case "session.ended":
        if (
          event.data.cause !== undefined &&
          "deliveryId" in event.data.cause &&
          event.data.cause.deliveryId === resetDeliveryId
        )
          entries = [];
        break;
    }
  }
  const conversation = conversationTurns(
    follows,
    selection === undefined ? latestTurnId : selection,
  );
  // A turn this stream never started is one it can't place, so its messages stay.
  const messages = entries.flatMap(({ message, turnId }) =>
    turnId === undefined || !follows.has(turnId) || conversation.has(turnId) ? [message] : [],
  );
  return { messages: maxMessages === undefined ? messages : messages.slice(-maxMessages) };
}

/** The turn that heads the conversation and the turns it follows back. */
function conversationTurns(
  follows: ReadonlyMap<string, string | null>,
  head: string | null | undefined,
): ReadonlySet<string> {
  const turns = new Set<string>();
  let turnId = head;
  while (turnId !== undefined && turnId !== null && !turns.has(turnId)) {
    turns.add(turnId);
    turnId = follows.get(turnId);
  }
  return turns;
}

function textOf(parts: readonly UserPart[]): string {
  return parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}
