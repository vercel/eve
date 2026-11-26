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
import { callPlace, partPlace, runPlace } from "#protocol/session-projection/reader.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface MessageSources {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
  readonly interactions: Readonly<Record<string, Interaction>>;
}

interface Placed {
  readonly at: number;
  readonly rank: number;
  readonly part: EveMessagePart;
}

export interface PlacedMessage {
  readonly at: number;
  readonly message: EveMessage;
}

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
    const at = partPlace(view, row);
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
    entries.sort((a, b) => a.at - b.at || a.rank - b.rank);
    const first = entries[0]?.at ?? Infinity;
    const openers = (received.get(turn.turnId) ?? [])
      .filter((entry) => entry.at > first)
      .sort((a, b) => a.at - b.at);
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

function textKind(kind: string): "text" | "reasoning" | undefined {
  return kind === "text" || kind === "reasoning" ? kind : undefined;
}

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
  if (row.capability.hidden === true) part.hidden = true;
  if ("callId" in row.owner) part.parentCallId = row.owner.callId;
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

function sendsMessage(
  row: DeliveryRow,
): row is DeliveryRow & { readonly parts: readonly UserPart[] } {
  return row.parts !== undefined && row.parts.length > 0;
}

export function userMessage(row: DeliveryRow): EveMessage | undefined {
  if (row.turnId === undefined || !sendsMessage(row)) return undefined;
  return {
    id: `${row.deliveryId}:user`,
    metadata: { status: "complete", turnId: row.turnId },
    parts: receivedParts(row.parts),
    role: "user",
  };
}

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
    parts: importedMessageParts(deliveryId, index, message),
    role: message.role,
  }));
}

function importedMessageParts(
  deliveryId: string,
  messageIndex: number,
  message: ImportedMessage,
): readonly EveMessagePart[] {
  if (message.parts === undefined) {
    return [{ state: "done", text: message.text, type: "text" }];
  }
  let stepIndex = 0;
  let sawToolInStep = false;
  return message.parts.map((part, partIndex): EveMessagePart => {
    if (part.type === "text") {
      if (sawToolInStep) {
        stepIndex += 1;
        sawToolInStep = false;
      }
      return { state: "done", stepIndex, text: part.text, type: "text" };
    }
    sawToolInStep = true;
    return {
      callId: `${deliveryId}:imported:${String(messageIndex)}:tool:${String(partIndex)}`,
      ...(part.error === undefined
        ? { output: part.output, state: "completed" as const }
        : { error: { code: "tool_error", message: part.error }, state: "failed" as const }),
      input: part.input ?? {},
      kind: "tool",
      label: displayTitle(part.name),
      name: part.name,
      stepIndex,
      type: "tool",
    };
  });
}

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
