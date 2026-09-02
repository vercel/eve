import type { ModelMessage, SystemModelMessage } from "ai";

interface AddCurrentMessageOptions {
  readonly cacheFriendly?: boolean;
}

interface CurrentMessagesOptions {
  readonly currentTurnMessages?: readonly ModelMessage[];
}

/** Model-call messages with cache-friendly placement for turn-local context. */
export function createCurrentMessages(
  history: readonly ModelMessage[],
  options: CurrentMessagesOptions = {},
): {
  readonly nonSystemMessages: readonly ModelMessage[];
  readonly systemMessages: readonly SystemModelMessage[];
  add(turnSequence: number, message: string, options?: AddCurrentMessageOptions): void;
  addSystem(messages: SystemModelMessage | readonly SystemModelMessage[]): void;
} {
  const systemMessages: SystemModelMessage[] = [];
  const nonSystemMessages: ModelMessage[] = [];
  const currentTurnMessages = new Set(options.currentTurnMessages);
  let currentTurnInsertionIndex: number | undefined;

  for (const message of history) {
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
  // The AI SDK collects approval responses only from the tail tool message.
  // Appending user-role context there would skip the approved tool's
  // execution and send the provider a tool call with no result.
  const canAppendUserMessages =
    currentTurnInsertionIndex !== undefined || !hasTailApprovalResponse(nonSystemMessages);

  return {
    add(turnSequence, message, { cacheFriendly = true } = {}) {
      if (turnSequence > 0 && cacheFriendly === true && canAppendUserMessages) {
        nonSystemMessages.splice(userInsertionIndex, 0, { role: "user", content: message });
        userInsertionIndex += 1;
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
