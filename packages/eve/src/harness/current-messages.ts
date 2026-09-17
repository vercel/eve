import type { ModelMessage, SystemModelMessage } from "ai";
import type { HistoryState } from "#context/keys.js";

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

const ANNOUNCEMENT_KINDS = {
  availableSkills: "context.state",
  deliveryInstruction: "context.instruction",
  taskState: "context.state",
} as const satisfies Record<keyof HistoryState, FrameworkMessageKind>;

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
  addAnnouncements(announcements: HistoryState): void;
  addSystem(messages: SystemModelMessage | readonly SystemModelMessage[]): void;
} {
  const durableMessages = [...history];
  const historyState = { ...options.historyState };
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
  // The AI SDK collects approval responses only from the tail tool message.
  // Appending user-role context there would skip the approved tool's
  // execution and send the provider a tool call with no result.
  const canAppendUserMessages =
    currentTurnInsertionIndex !== undefined || !hasTailApprovalResponse(nonSystemMessages);

  function add(
    message: string,
    kind: FrameworkMessageKind,
    { cacheFriendly = true }: AddCurrentMessageOptions = {},
  ): boolean {
    if (cacheFriendly && canAppendUserMessages) {
      const entry = createFrameworkUserMessage(kind, message);
      nonSystemMessages.splice(userInsertionIndex, 0, entry);
      durableMessages.splice(historyInsertionIndex, 0, entry);
      userInsertionIndex += 1;
      historyInsertionIndex += 1;
      return true;
    }
    systemMessages.push({ role: "system", content: message });
    return false;
  }

  return {
    add,
    addAnnouncements(announcements) {
      for (const key of ["availableSkills", "taskState", "deliveryInstruction"] as const) {
        const message = announcements[key];
        if (message === undefined || message.length === 0 || historyState[key] === message)
          continue;
        if (add(message, ANNOUNCEMENT_KINDS[key])) historyState[key] = message;
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
