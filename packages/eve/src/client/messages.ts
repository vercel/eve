import { callState } from "#protocol/session-projection/selectors.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import { callLabel } from "#protocol/session-projection/selectors.js";
import type { EveMessage, EveMessagePart, EveToolPart } from "#client/message-types.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { ImportedMessage } from "#protocol/session-events/families/delivery.js";
import { callOutputSource } from "#protocol/session-projection/selectors.js";
import type {
  CallPreview,
  CallRow,
  DeliveryRow,
  SessionPreviews,
  SessionView,
} from "#protocol/session-projection/tables.js";
import { callPlace, runPlace } from "#protocol/session-projection/reader.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What a turn's message derives from: the tables, their previews, and the interactions shown. */
export interface MessageSources {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
  readonly interactions: Readonly<Record<string, Interaction>>;
}

/** A part and where it sorts in its turn: by the line that introduced it, previews last. */
interface Placed {
  readonly at: number;
  readonly rank: number;
  readonly part: EveMessagePart;
}

/** A message and the stream position it sorts at among its turn's messages. */
export interface PlacedMessage {
  readonly at: number;
  readonly message: EveMessage;
}

/**
 * The agent's messages for each of `turnIds` (every turn when absent): what its runs wrote and
 * called, and what it asked that no call carries, in the order the stream introduced them. A
 * message a person sent while the turn worked splits it, so what the agent did before it reads
 * above it and the rest below; each piece sorts at its first part, the last at the end. A turn
 * that has requested no run and shows nothing has no message.
 */
export function assistantMessages(
  sources: MessageSources,
  turnIds?: ReadonlySet<string>,
): ReadonlyMap<string, readonly PlacedMessage[]> {
  const { interactions, previews, view } = sources;
  const shows = (turnId: string | undefined): turnId is string =>
    turnId !== undefined && (turnIds === undefined || turnIds.has(turnId));
  const placed = new Map<string, Placed[]>();
  const results = new Map<string, unknown>();
  const place = (turnId: string, entry: Placed) => {
    const entries = placed.get(turnId);
    if (entries === undefined) placed.set(turnId, [entry]);
    else entries.push(entry);
  };

  // An approval or a question about one of the session's calls shows on that call.
  const onCall = new Map<string, Interaction>();
  for (const interaction of Object.values(interactions)) {
    const row = view.interactions[interaction.interactionId];
    const callId = row !== undefined && "callId" in row.subject ? row.subject.callId : undefined;
    const kind = interaction.request.kind;
    if (
      callId !== undefined &&
      view.calls[callId] !== undefined &&
      (kind === "approval" || kind === "question")
    ) {
      onCall.set(callId, interaction);
    } else if (row !== undefined && shows(interaction.turnId)) {
      place(interaction.turnId, {
        at: row.introducedAt,
        part: { ...interaction, type: "interaction" },
        rank: 2,
      });
    }
  }

  for (const row of Object.values(view.parts)) {
    const at = runPlace(view, row.runId);
    if (!shows(at?.turnId)) continue;
    if (row.kind === "result") results.set(at.turnId, row.value);
    const type = textKind(row.kind);
    if (type === undefined || typeof row.value !== "string") continue;
    place(at.turnId, {
      at: row.introducedAt,
      part: { id: row.partId, state: "done", stepIndex: at.stepIndex, text: row.value, type },
      rank: 0,
    });
  }

  for (const row of Object.values(view.calls)) {
    // A run a retry replaced leaves its calls behind; the replacement asks again.
    if (row.outcome === "abandoned") continue;
    const at = callPlace(view, row.callId);
    if (!shows(at?.turnId)) continue;
    const part = toolPart(
      view,
      row,
      previews.calls[row.callId],
      onCall.get(row.callId),
      at.stepIndex,
    );
    place(at.turnId, { at: row.introducedAt, part: { ...part, stepIndex: at.stepIndex }, rank: 1 });
  }

  for (const preview of Object.values(previews.parts)) {
    const at = runPlace(view, preview.runId);
    const type = textKind(preview.kind);
    if (!shows(at?.turnId) || type === undefined) continue;
    place(at.turnId, {
      at: Infinity,
      part: {
        id: preview.partId,
        state: "streaming",
        stepIndex: at.stepIndex,
        text: preview.text,
        type,
      },
      rank: 0,
    });
  }
  for (const preview of Object.values(previews.calls)) {
    const at = runPlace(view, preview.runId);
    if (
      !shows(at?.turnId) ||
      preview.kind === undefined ||
      view.calls[preview.callId] !== undefined
    )
      continue;
    place(at.turnId, {
      at: Infinity,
      part: {
        callId: preview.callId,
        inputText: preview.input,
        kind: preview.kind,
        label: displayTitle(preview.name),
        name: preview.name,
        state: "streaming",
        stepIndex: at.stepIndex,
        type: "tool",
      },
      rank: 1,
    });
  }

  // Where each turn took in a message a person sent: those after it showed something split it.
  const received = new Map<string, { readonly deliveryId: string; readonly at: number }[]>();
  for (const row of Object.values(view.deliveries)) {
    if (!shows(row.turnId) || row.consumedAt === undefined || !sendsMessage(row)) continue;
    const entry = { at: row.consumedAt, deliveryId: row.deliveryId };
    const entries = received.get(row.turnId);
    if (entries === undefined) received.set(row.turnId, [entry]);
    else entries.push(entry);
  }

  const messages = new Map<string, readonly PlacedMessage[]>();
  for (const turn of Object.values(view.turns)) {
    if (!shows(turn.turnId)) continue;
    const entries = placed.get(turn.turnId) ?? [];
    if (entries.length === 0 && (turn.runs ?? 0) === 0) {
      messages.set(turn.turnId, []);
      continue;
    }
    // Content commits as it completes, so the line that introduced a row is its place.
    entries.sort((a, b) => a.at - b.at || a.rank - b.rank);
    const first = entries[0]?.at ?? Infinity;
    const openers = (received.get(turn.turnId) ?? [])
      .filter((entry) => entry.at > first)
      .sort((a, b) => a.at - b.at);
    // One piece before the first opener, then one after each.
    const pieces: Placed[][] = [[], ...openers.map((): Placed[] => [])];
    for (const entry of entries) {
      pieces[openers.filter((opener) => opener.at < entry.at).length]?.push(entry);
    }
    const running = turn.status !== "settled";
    const last = running
      ? pieces.length - 1
      : Math.max(
          0,
          pieces.findLastIndex((parts) => parts.length > 0),
        );
    const shown: PlacedMessage[] = [];
    pieces.forEach((parts, index) => {
      // The last piece stands while the turn works on, so what comes next has somewhere to go.
      if (parts.length === 0 && !(index === last && (running || last === 0))) return;
      const metadata: Mutable<NonNullable<EveMessage["metadata"]>> = {
        status: index === last && running ? "streaming" : "complete",
        turnId: turn.turnId,
      };
      if (index === last && results.has(turn.turnId)) metadata.result = results.get(turn.turnId);
      const opener = index === 0 ? undefined : openers[index - 1]?.deliveryId;
      shown.push({
        at: parts[0]?.at ?? Infinity,
        message: {
          id:
            opener === undefined
              ? `${turn.turnId}:assistant`
              : `${turn.turnId}:${opener}:assistant`,
          metadata,
          parts: parts.map((entry) => entry.part),
          role: "assistant",
        },
      });
    });
    messages.set(turn.turnId, shown);
  }
  return messages;
}

/** The content kinds a message shows as text: its text and its reasoning. */
function textKind(kind: string): "text" | "reasoning" | undefined {
  return kind === "text" || kind === "reasoning" ? kind : undefined;
}

/** A call as its row stands, with the latest preview of its output while it runs. */
function toolPart(
  view: SessionView,
  row: CallRow,
  preview: CallPreview | undefined,
  interaction: Interaction | undefined,
  stepIndex: number,
): EveToolPart {
  const { kind, name } = row.capability;
  const running = row.status !== "settled";
  const part: Mutable<Exclude<EveToolPart, { state: "streaming" }>> = {
    callId: row.callId,
    kind,
    label: callLabel(row, preview),
    name,
    state: callState(view, row.callId)!,
    stepIndex,
    type: "tool",
  };
  if (row.input !== undefined) part.input = row.input;
  const output = running
    ? preview?.output
    : row.outcome === "completed"
      ? callOutputSource(view, row.callId)?.output
      : undefined;
  if (output !== undefined) part.output = output;
  const error = row.error ?? row.inputError;
  if (error !== undefined) part.error = error;
  if (interaction !== undefined) part.interaction = interaction;
  return part;
}

/** Whether a delivery carries something a person sent, not only answers or context. */
function sendsMessage(
  row: DeliveryRow,
): row is DeliveryRow & { readonly parts: readonly UserPart[] } {
  return row.parts !== undefined && row.parts.length > 0;
}

/** What a person sent, as the turn that consumed it received it. An answer sends no message. */
export function userMessage(row: DeliveryRow): EveMessage | undefined {
  if (row.turnId === undefined || !sendsMessage(row)) return undefined;
  return {
    id: `${row.deliveryId}:user`,
    metadata: { status: "complete", turnId: row.turnId },
    parts: receivedParts(row.parts),
    role: "user",
  };
}

/**
 * The earlier conversation a delivery imported, as messages. They name no turn, so a turn's reply
 * never streams into an imported assistant message.
 */
export function importedMessages(
  deliveryId: string,
  history: readonly ImportedMessage[],
): readonly EveMessage[] {
  return history.map((message, index) => ({
    id: `${deliveryId}:imported:${String(index)}`,
    metadata:
      message.id === undefined
        ? { imported: true, status: "complete" }
        : { historyId: message.id, imported: true, status: "complete" },
    parts: [{ state: "done", text: message.text, type: "text" }],
    role: message.role,
  }));
}

/** A person's parts as message parts: text, and files by their metadata. */
function receivedParts(parts: readonly UserPart[]): readonly EveMessagePart[] {
  return parts.map((part) =>
    part.kind === "text"
      ? { state: "done", text: part.text, type: "text" }
      : {
          filename: part.filename,
          mediaType: part.mediaType,
          size: part.size,
          type: "file",
          url: part.url,
        },
  );
}
