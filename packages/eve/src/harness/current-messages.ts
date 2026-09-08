import type { ModelMessage, SystemModelMessage } from "ai";
import type { HistoryState } from "#context/keys.js";

interface AddCurrentMessageOptions {
  readonly cacheFriendly?: boolean;
  readonly historyKey?: keyof HistoryState;
}

interface CurrentMessagesOptions {
  readonly historyState?: HistoryState;
  readonly currentTurnMessages?: readonly ModelMessage[];
  readonly projectedMessages?: readonly ModelMessage[];
}

/** Builds the model view and durable history for one step. */
export function createCurrentMessages(
  history: readonly ModelMessage[],
  options: CurrentMessagesOptions = {},
): {
  readonly history: readonly ModelMessage[];
  readonly historyState: HistoryState;
  readonly nonSystemMessages: readonly ModelMessage[];
  readonly systemMessages: readonly SystemModelMessage[];
  add(message: string, options?: AddCurrentMessageOptions): void;
  addSystem(messages: SystemModelMessage | readonly SystemModelMessage[]): void;
} {
  const durableMessages = [...history];
  const historyState = { ...options.historyState };
  const systemMessages: SystemModelMessage[] = [];
  const nonSystemMessages: ModelMessage[] = [];
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
  // The AI SDK collects approval responses only from the tail tool message.
  // Appending user-role context there would skip the approved tool's
  // execution and send the provider a tool call with no result.
  const canAppendUserMessages =
    currentTurnInsertionIndex !== undefined || !hasTailApprovalResponse(nonSystemMessages);

  return {
    add(message, { cacheFriendly = true, historyKey } = {}) {
      if (historyKey !== undefined && historyState[historyKey] === message) return;
      if (cacheFriendly && canAppendUserMessages) {
        const entry = { role: "user" as const, content: message };
        nonSystemMessages.splice(userInsertionIndex, 0, entry);
        durableMessages.splice(historyInsertionIndex, 0, entry);
        userInsertionIndex += 1;
        historyInsertionIndex += 1;
        if (historyKey !== undefined) historyState[historyKey] = message;
      } else {
        systemMessages.push({ role: "system", content: message });
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

/** True when the history ends with a tool message carrying a tool-approval-response. */
export function hasTailApprovalResponse(messages: readonly ModelMessage[]): boolean {
  const tail = messages.at(-1);
  return (
    tail?.role === "tool" && tail.content.some((part) => part.type === "tool-approval-response")
  );
}
