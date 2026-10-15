import type { ConversationInteraction } from "#client/conversation-state.js";
import type { EveMessage, EveMessagePart, EveToolPart } from "#client/message-types.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import { callOutputSource } from "#protocol/session-projection/selectors.js";
import type {
  CallPreview,
  CallRow,
  DeliveryRow,
  SessionPreviews,
  SessionView,
} from "#protocol/session-projection/tables.js";
import { callPlace, runPlace } from "#protocol/session-reader.js";
import { displayTitle } from "#shared/display-name.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What a turn's message derives from: the tables, their previews, and the interactions shown. */
export interface MessageSources {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
  readonly interactions: Readonly<Record<string, ConversationInteraction>>;
}

/** A part and where it sorts in its turn: by the line that introduced it, previews last. */
interface Placed {
  readonly at: number;
  readonly rank: number;
  readonly part: EveMessagePart;
}

/**
 * The agent's message for each of `turnIds` (every turn when absent): what its runs wrote and
 * called, and what it asked that no call carries, in the order the stream introduced them. A turn
 * that has requested no run and shows nothing has no message.
 */
export function assistantMessages(
  sources: MessageSources,
  turnIds?: ReadonlySet<string>,
): ReadonlyMap<string, EveMessage | undefined> {
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
  const onCall = new Map<string, ConversationInteraction>();
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
    const part = toolPart(view, row, previews.calls[row.callId], onCall.get(row.callId));
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
    if (!shows(at?.turnId) || view.calls[preview.callId] !== undefined) continue;
    place(at.turnId, {
      at: Infinity,
      part: {
        callId: preview.callId,
        inputText: preview.input,
        label: displayTitle(preview.name),
        name: preview.name,
        status: "streaming",
        stepIndex: at.stepIndex,
        type: "tool",
      },
      rank: 1,
    });
  }

  const messages = new Map<string, EveMessage | undefined>();
  for (const turn of Object.values(view.turns)) {
    if (!shows(turn.turnId)) continue;
    const entries = placed.get(turn.turnId) ?? [];
    if (entries.length === 0 && (turn.runs ?? 0) === 0) {
      messages.set(turn.turnId, undefined);
      continue;
    }
    // Content commits as it completes, so the line that introduced a row is its place.
    entries.sort((a, b) => a.at - b.at || a.rank - b.rank);
    const metadata: Mutable<NonNullable<EveMessage["metadata"]>> = {
      status: turn.status === "settled" ? "complete" : "streaming",
      turnId: turn.turnId,
    };
    if (results.has(turn.turnId)) metadata.result = results.get(turn.turnId);
    messages.set(turn.turnId, {
      id: `${turn.turnId}:assistant`,
      metadata,
      parts: entries.map((entry) => entry.part),
      role: "assistant",
    });
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
  interaction: ConversationInteraction | undefined,
): EveToolPart {
  const { kind, name, label } = row.capability;
  const running = row.status !== "settled";
  const part: Mutable<EveToolPart> = {
    callId: row.callId,
    kind,
    label: row.label ?? (running ? preview?.label : undefined) ?? label ?? displayTitle(name),
    name,
    status: row.status,
    type: "tool",
  };
  if (row.input !== undefined) part.input = row.input;
  if (row.outcome !== undefined) part.outcome = row.outcome;
  const output = running
    ? preview?.output
    : row.outcome === "completed"
      ? callOutputSource(view, row.callId)?.output
      : undefined;
  if (output !== undefined) part.output = output;
  const error = row.error ?? row.inputError;
  if (error !== undefined) part.error = error;
  if (row.reason !== undefined) part.reason = row.reason;
  if (row.taskId !== undefined) part.taskId = row.taskId;
  if (interaction !== undefined) part.interaction = interaction;
  return part;
}

/** What a person sent, as the turn that consumed it received it. An answer sends no message. */
export function userMessage(row: DeliveryRow): EveMessage | undefined {
  if (row.turnId === undefined || row.parts === undefined || row.parts.length === 0)
    return undefined;
  return {
    id: `${row.deliveryId}:user`,
    metadata: { status: "complete", turnId: row.turnId },
    parts: receivedParts(row.parts),
    role: "user",
  };
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
