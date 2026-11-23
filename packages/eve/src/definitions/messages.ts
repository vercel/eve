import { type Announcement, announcementDigest } from "#harness/announcements.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  turnAnchorOf,
} from "#harness/messages.js";
import { awaitsProviderToolResult } from "#harness/provider-tool-history.js";
import type { AnchoredEntry, CallRecord } from "./definition.js";

export function announce(
  draft: CallRecord,
  currentInput: ReadonlySet<HarnessModelMessage>,
  announcements: Readonly<Record<string, Announcement>>,
): CallRecord & { readonly view: readonly HarnessModelMessage[] } {
  if (awaitsProviderToolResult(draft.record)) return { ...draft, view: draft.record };
  const added: HarnessModelMessage[] = [];
  const retained: HarnessModelMessage[] = [];
  let announced = draft.historyState.announcements;
  let messages = draft.historyState.messages;
  let changed = false;
  for (const [key, announcement] of Object.entries(announcements)) {
    const previous = announced?.[key];
    if ((previous ?? announcement.initial) === announcement.value) continue;
    const content = announcement.render(previous);
    const { [key]: _said, ...others } = messages ?? {};
    messages = others;
    if (content !== undefined) {
      const message = createFrameworkUserMessage(announcement.kind ?? "context.state", content);
      added.push(message);
      if (announcement.transient !== true) {
        retained.push(message);
        messages = { ...messages, [key]: announcementDigest(message.kind, message.content) };
      }
    }
    announced = { ...announced, [key]: announcement.value };
    changed = true;
  }
  if (!changed) return { ...draft, view: draft.record };
  const at = draft.record.findIndex((message) => currentInput.has(message));
  const index = at === -1 ? draft.record.length : at;
  const insert = (entries: readonly HarnessModelMessage[]) =>
    entries.length === 0
      ? draft.record
      : [...draft.record.slice(0, index), ...entries, ...draft.record.slice(index)];
  const record = insert(retained);
  return {
    historyState: { ...draft.historyState, announcements: announced, messages },
    record,
    view: retained.length === added.length ? record : insert(added),
  };
}

export function placeAnchored(
  messages: readonly HarnessModelMessage[],
  entries: readonly AnchoredEntry[],
): HarnessModelMessage[] {
  if (entries.length === 0) return [...messages];
  const anchors = new Map<string, number>();
  messages.forEach((message, index) => {
    const turnId = turnAnchorOf(message);
    if (turnId !== undefined && !anchors.has(turnId)) anchors.set(turnId, index);
  });
  const unanchored = checkpointLength(messages);
  const at = entries.map(({ turnId }) => anchors.get(turnId) ?? unanchored);
  const placed: HarnessModelMessage[] = [];
  for (let index = 0; index <= messages.length; index += 1) {
    entries.forEach((entry, entryIndex) => {
      if (at[entryIndex] === index) placed.push(entry.message);
    });
    if (index < messages.length) placed.push(messages[index]!);
  }
  return placed;
}

function checkpointLength(messages: readonly HarnessModelMessage[]): number {
  const [marker, summary] = messages;
  return marker?.role === "user" &&
    marker.kind === "context.compaction" &&
    summary?.role === "assistant"
    ? 2
    : 0;
}
