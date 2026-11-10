import type { ModelMessage, SystemModelMessage } from "ai";

import type { HistoryState } from "#context/keys.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applySystemCacheBreakpoint } from "#harness/prompt-cache.js";

/** One model call's messages: what the step commits, and what the model reads. */
export interface RequestMessages {
  readonly history: readonly HarnessModelMessage[];
  readonly historyState: HistoryState;
  readonly nonSystemMessages: readonly HarnessModelMessage[];
}

/**
 * The system prompt as the model receives it, as one message or as two.
 *
 * `instructions` has two kinds of content. The base is the same for every session of an agent.
 * The own parts differ by session: channel, user, tasks and approvals. A retry's `extraSystemNote`
 * differs by call. A string is a prompt with a base and no own parts.
 *
 * Anthropic reads a cached prefix up to a breakpoint, and a later request reuses it only when its
 * prefix is identical. Joined into one message, the base and a session's own parts end at one
 * breakpoint, so session B, whose own parts differ, never matches the prefix session A cached:
 *
 *   one message:   [ base + own A ]|        session B's [ base + own B ] shares nothing
 *   two messages:  [ base ]|  [ own A ]     session B's [ base ]| shares the cached base
 *
 * So a model that caches by message prefix gets the base as a message of its own, with the
 * breakpoint, then the note and the own parts as a second message with none. Sessions share the
 * base, and a request keeps within Anthropic's 4 breakpoints. Two cases do this:
 *
 * - eve places its own breakpoints (`anthropicCache`), which a 1-hour cache needs and a direct
 *   Anthropic model uses. The breakpoint goes on the base message.
 * - Anthropic through Gateway's automatic caching. Gateway anchors a breakpoint on the first
 *   message (`cacheAnchorMessageIndex: 0`), which is the base.
 *
 * Any other model gets one system message, and a string alone is passed as it is.
 */
export function modelInstructions(input: {
  readonly instructions: string | readonly string[];
  readonly profile: Pick<ModelProfile, "anthropicCache" | "gateway" | "provider">;
  readonly extraSystemNote?: string;
}): SystemModelMessage | SystemModelMessage[] | string | undefined {
  const { anthropicCache, gateway, provider } = input.profile;
  const [base = "", ...own] =
    typeof input.instructions === "string" ? [input.instructions] : input.instructions;
  const note = input.extraSystemNote ?? "";

  const gatewayAnchorsFirstMessage = gateway && provider === "anthropic";
  if (anthropicCache === undefined && typeof input.instructions === "string" && note === "") {
    return input.instructions;
  }
  if (anthropicCache === undefined && !gatewayAnchorsFirstMessage) {
    return systemMessage([note, base, ...own]);
  }

  const baseMessage = systemMessage([base]);
  const ownMessage = systemMessage([note, ...own]);
  const messages = [
    ...(baseMessage === undefined
      ? []
      : anthropicCache
        ? applySystemCacheBreakpoint([baseMessage], anthropicCache)
        : [baseMessage]),
    ...(ownMessage === undefined ? [] : [ownMessage]),
  ];
  return messages.length > 1 ? messages : messages[0];
}

/** The parts joined into one system message, empty ones skipped, or nothing if none is left. */
function systemMessage(parts: readonly string[]): SystemModelMessage | undefined {
  const content = parts.filter((part) => part !== "").join("\n\n");
  return content === "" ? undefined : { role: "system", content };
}

/** A retry's note, trailing the call's messages. */
export function withTrailingUserNote(
  messages: readonly ModelMessage[],
  note?: string,
): ModelMessage[] {
  return note ? [...messages, createFrameworkUserMessage("execution.retry", note)] : [...messages];
}
