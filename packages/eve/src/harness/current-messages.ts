import type { SystemModelMessage } from "ai";
import type { HistoryState } from "#context/keys.js";
import type { Announcement } from "#harness/announcements.js";

import {
  createFrameworkUserMessage,
  type FrameworkMessageKind,
  type HarnessModelMessage,
} from "#harness/messages.js";

interface AddCurrentMessageOptions {
  readonly cacheFriendly?: boolean;
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
  /** Adds context this call reads ahead of the turn's input without keeping it in history. */
  addContext(message: string, kind: FrameworkMessageKind): void;
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
    addContext(message, kind) {
      nonSystemMessages.splice(userInsertionIndex, 0, createFrameworkUserMessage(kind, message));
      userInsertionIndex += 1;
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
