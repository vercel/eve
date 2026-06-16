import type { ModelMessage } from "ai";

import { estimateTokens } from "#harness/compaction.js";

/**
 * Placeholder text injected in place of pruned tool-result content.
 */
const PRUNED_PLACEHOLDER = "[Tool result pruned to save context. Call the tool again if needed.]";

/**
 * Token budget reserved for recent tool results that must not be pruned.
 *
 * Tool results whose cumulative token estimate (walking backwards from
 * the end of the history) fits within this window are protected from
 * pruning. Everything older is eligible for replacement.
 */
const PRUNE_PROTECT_TOKENS = 40_000;

/**
 * Minimum token savings before pruning is applied.
 *
 * If the total tokens reclaimed by pruning would be below this threshold,
 * the messages are returned unmodified. This avoids churn from replacing
 * tiny tool results.
 */
const PRUNE_MIN_SAVINGS = 20_000;

/**
 * Content part type for a tool result within a `ModelMessage`.
 */
interface ToolResultContentPart {
  readonly type: "tool-result";
  readonly toolName: string;
  readonly output?: unknown;
  readonly [key: string]: unknown;
}

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultOutput = Extract<ToolResponsePart, { type: "tool-result" }>["output"];

/**
 * Reactively prunes old tool-result content from conversation history.
 *
 * Recent results inside {@link PRUNE_PROTECT_TOKENS} are preserved.
 * Older results are replaced with {@link PRUNED_PLACEHOLDER}.
 */
export function pruneToolResults(messages: readonly ModelMessage[]): ModelMessage[] {
  const locations = collectToolResultLocations(messages);
  if (locations.length === 0) {
    return messages as ModelMessage[];
  }

  let protectedTokens = 0;
  let reclaimableTokens = 0;
  const toPrune: Set<string> = new Set();

  for (const loc of locations) {
    if (protectedTokens < PRUNE_PROTECT_TOKENS) {
      protectedTokens += loc.tokens;
    } else {
      toPrune.add(loc.key);
      reclaimableTokens += loc.tokens;
    }
  }

  if (reclaimableTokens < PRUNE_MIN_SAVINGS) {
    return messages as ModelMessage[];
  }

  return messages.map((message, messageIndex) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }

    let mutated = false;
    const content = message.content.map((part, partIndex) => {
      const key = `${messageIndex}:${partIndex}`;
      if (!toPrune.has(key)) {
        return part;
      }

      mutated = true;
      return {
        ...part,
        output: createPrunedToolResultOutput(PRUNED_PLACEHOLDER),
      };
    });

    if (!mutated) {
      return message;
    }

    return { ...message, content: content as typeof message.content } as ModelMessage;
  });
}

/**
 * Location descriptor for one tool-result content part within the
 * message array.
 */
interface ToolResultLocation {
  /** Unique key: `"messageIndex:partIndex"` */
  readonly key: string;
  /** Estimated token cost of this tool result. */
  readonly tokens: number;
}

/**
 * Collects all tool-result locations from messages, ordered newest-first.
 *
 * Each tool-result part is estimated individually via {@link estimateTokens}
 * so mixed-size parallel results (e.g. one large read_file and two tiny
 * results in one message) are budgeted by individual cost instead of an
 * averaged per-message total.
 */
function collectToolResultLocations(messages: readonly ModelMessage[]): ToolResultLocation[] {
  const locations: ToolResultLocation[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j] as ToolResultContentPart | undefined;
      if (part?.type !== "tool-result") {
        continue;
      }

      locations.push({
        key: `${i}:${j}`,
        tokens: estimateTokens(part),
      });
    }
  }

  return locations;
}

function createPrunedToolResultOutput(text: string): ToolResultOutput {
  return {
    type: "text",
    value: text,
  };
}
