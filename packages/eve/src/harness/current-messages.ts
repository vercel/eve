import type { SystemModelMessage } from "ai";
import type { HistoryState } from "#context/keys.js";
import type { Announcement } from "#harness/announcements.js";

import {
  createFrameworkUserMessage,
  type FrameworkMessageKind,
  type HarnessModelMessage,
  turnAnchorOf,
} from "#harness/messages.js";

interface AddCurrentMessageOptions {
  readonly cacheFriendly?: boolean;
}

/** Context for a model call that belongs with one turn's input. */
export interface AnchoredContext {
  readonly turnId: string;
  readonly content: string;
}

interface CurrentMessagesOptions {
  readonly historyState?: HistoryState;
  readonly currentTurnMessages?: readonly HarnessModelMessage[];
  readonly projectedMessages?: readonly HarnessModelMessage[];
}

/** Builds the model view and durable history for one step. */
export function createCurrentMessages(
  history: readonly HarnessModelMessage[],
  options: CurrentMessagesOptions = {},
): {
  readonly history: readonly HarnessModelMessage[];
  readonly historyState: HistoryState;
  readonly nonSystemMessages: readonly HarnessModelMessage[];
  readonly systemMessages: readonly SystemModelMessage[];
  add(message: string, kind: FrameworkMessageKind, options?: AddCurrentMessageOptions): void;
  /**
   * Adds context for this call without keeping it in history, each entry just ahead of the input
   * its turn brought. Add it last: what's added after would land between it and that input.
   */
  addAnchored(entries: readonly AnchoredContext[], kind: FrameworkMessageKind): void;
  addAnnouncements(announcements: Readonly<Record<string, Announcement>>): void;
  addSystem(messages: SystemModelMessage | readonly SystemModelMessage[]): void;
} {
  const durableMessages = [...history];
  const historyState: { -readonly [K in keyof HistoryState]: HistoryState[K] } = {
    ...options.historyState,
  };
  const systemMessages: SystemModelMessage[] = [];
  const nonSystemMessages: HarnessModelMessage[] = [];
  const currentTurnMessages = new Set(options.currentTurnMessages);
  let currentTurnInsertionIndex: number | undefined;

  for (const message of options.projectedMessages ?? history) {
    if (currentTurnInsertionIndex === undefined && currentTurnMessages.has(message)) {
      currentTurnInsertionIndex = nonSystemMessages.length;
    }
    if (message.role === "system") {
      systemMessages.push(message);
    } else {
      nonSystemMessages.push(message);
    }
  }
  let userInsertionIndex = currentTurnInsertionIndex ?? nonSystemMessages.length;
  const currentInputIndex = history.findIndex((message) => currentTurnMessages.has(message));
  let historyInsertionIndex = currentInputIndex === -1 ? history.length : currentInputIndex;
  function appendUserMessage(message: string, kind: FrameworkMessageKind): void {
    const entry = createFrameworkUserMessage(kind, message);
    nonSystemMessages.splice(userInsertionIndex, 0, entry);
    durableMessages.splice(historyInsertionIndex, 0, entry);
    userInsertionIndex += 1;
    historyInsertionIndex += 1;
  }

  function add(
    message: string,
    kind: FrameworkMessageKind,
    { cacheFriendly = true }: AddCurrentMessageOptions = {},
  ): void {
    if (cacheFriendly) {
      appendUserMessage(message, kind);
      return;
    }
    systemMessages.push({ role: "system", content: message });
  }

  return {
    add,
    addAnchored(entries, kind) {
      if (entries.length === 0) return;
      // Every later call finds a turn's input where it was, so context ahead of it keeps the
      // prompt before it cached. Context whose turn's input compaction summarized, or a turn
      // that brought none, sits after the compaction's checkpoint instead.
      const anchors = new Map<string, number>();
      nonSystemMessages.forEach((message, index) => {
        const turnId = turnAnchorOf(message);
        if (turnId !== undefined && !anchors.has(turnId)) anchors.set(turnId, index);
      });
      const unanchored = checkpointLength(nonSystemMessages);
      const at = entries.map(({ turnId }) => anchors.get(turnId) ?? unanchored);
      const placed: HarnessModelMessage[] = [];
      let shift = 0;
      for (let index = 0; index <= nonSystemMessages.length; index += 1) {
        entries.forEach((entry, entryIndex) => {
          if (at[entryIndex] !== index) return;
          placed.push(createFrameworkUserMessage(kind, entry.content));
          if (index <= userInsertionIndex) shift += 1;
        });
        if (index < nonSystemMessages.length) placed.push(nonSystemMessages[index]!);
      }
      nonSystemMessages.splice(0, nonSystemMessages.length, ...placed);
      userInsertionIndex += shift;
    },
    addAnnouncements(announcements) {
      for (const key of Object.keys(announcements).sort()) {
        const announcement = announcements[key]!;
        const previous = historyState.announcements?.[key];
        if (previous === announcement.value) continue;
        appendUserMessage(announcement.render(previous), "context.state");
        historyState.announcements = { ...historyState.announcements, [key]: announcement.value };
      }
    },
    addSystem(messages) {
      systemMessages.push(...(Array.isArray(messages) ? messages : [messages]));
    },
    get nonSystemMessages() {
      return [...nonSystemMessages];
    },
    get history() {
      return [...durableMessages];
    },
    get historyState() {
      return { ...historyState };
    },
    get systemMessages() {
      return [...systemMessages];
    },
  };
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
