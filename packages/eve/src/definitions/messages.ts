import type { Announcement } from "#harness/announcements.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  turnAnchorOf,
} from "#harness/messages.js";
import { awaitsProviderToolResult } from "#harness/provider-tool-history.js";
import type { AnchoredEntry, CallRecord } from "./definition.js";

// Placing what definitions add to a call's messages.

/**
 * Announcements join the record ahead of the turn's input, or at its end on a step that continues
 * from tool results: only a changed value adds a message, so the prompt before it stays cached. A
 * provider tool's pending result must open the next response, so then nothing joins; the next
 * request carries them.
 */
export function announce(
  draft: CallRecord,
  currentInput: ReadonlySet<HarnessModelMessage>,
  announcements: Readonly<Record<string, Announcement>>,
): CallRecord {
  if (awaitsProviderToolResult(draft.record)) return draft;
  const added: HarnessModelMessage[] = [];
  let announced = draft.historyState.announcements;
  for (const key of Object.keys(announcements).sort()) {
    const announcement = announcements[key]!;
    const previous = announced?.[key];
    if (previous === announcement.value) continue;
    added.push(createFrameworkUserMessage("context.state", announcement.render(previous)));
    announced = { ...announced, [key]: announcement.value };
  }
  if (added.length === 0) return draft;
  const at = draft.record.findIndex((message) => currentInput.has(message));
  const index = at === -1 ? draft.record.length : at;
  return {
    ...draft,
    historyState: { ...draft.historyState, announcements: announced },
    record: [...draft.record.slice(0, index), ...added, ...draft.record.slice(index)],
  };
}

/**
 * Each entry just ahead of the first message its turn anchors. Every later call finds a turn's
 * input where it was, so context ahead of it keeps the prompt before it cached. Context whose
 * turn's input compaction summarized, or a turn that brought none, sits after the compaction's
 * checkpoint instead.
 */
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

/** How many messages a compacted history opens with: its checkpoint and the summary. */
function checkpointLength(messages: readonly HarnessModelMessage[]): number {
  const [marker, summary] = messages;
  return marker?.role === "user" &&
    marker.kind === "context.compaction" &&
    summary?.role === "assistant"
    ? 2
    : 0;
}
