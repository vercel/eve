import {
  type CompactionContext,
  CompactionOverflowError,
  type CompactionStrategy,
  type CompactionSummaryOptions,
  type StoredHistoryMessage,
} from "eve/compaction";

// Ported from openai/codex @ 184c9c55: codex-rs/core/src/compact.rs (local compaction) and
// session/context_window.rs (when it runs).

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
/** A model's default auto-compact limit, as a share of its context window. */
export const AUTO_COMPACT_SHARE = 9 / 10;
/** `effective_context_window_percent`: the share of the window Codex treats as usable. */
export const EFFECTIVE_WINDOW_SHARE = 95 / 100;

export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include: Current progress and key decisions made; Important context, constraints, or user preferences; What remains to be done (clear next steps); Any critical data, examples, or references needed to continue.
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export interface CodexCompactionOptions {
  /** `model_auto_compact_token_limit`. Defaults to 90% of the context window. */
  readonly autoCompactTokenLimit?: number;
  /**
   * `model_post_turn_compact_threshold_percent`: compact after a turn once it fills this share
   * (0 to 1) of the usable window. Codex's default, 0, never compacts after a turn.
   */
  readonly postTurnPercent?: number;
  readonly userMessageBudget?: number;
  readonly model?: CompactionSummaryOptions["model"];
}

export function codexCompaction(options: CodexCompactionOptions = {}): CompactionStrategy {
  const postTurnPercent = options.postTurnPercent ?? 0;
  const budget = options.userMessageBudget ?? COMPACT_USER_MESSAGE_MAX_TOKENS;
  return {
    when: {
      phases: ["step", "turn-end"],
      due(measure) {
        const fullLimit = measure.contextWindowTokens * EFFECTIVE_WINDOW_SHARE;
        const autoLimit =
          options.autoCompactTokenLimit ?? measure.contextWindowTokens * AUTO_COMPACT_SHARE;
        const limitReached = measure.inputTokens >= Math.min(autoLimit, fullLimit);
        if (measure.phase === "step") return limitReached;
        return (
          postTurnPercent > 0 &&
          (limitReached || measure.inputTokens >= fullLimit * postTurnPercent)
        );
      },
    },
    async compact(history, ctx) {
      const summary = await summarizeTrimming(history, ctx, options.model);
      return [
        ...retainedUserMessages(history, budget, ctx),
        { content: `${SUMMARY_PREFIX}\n${summary}`, kind: "context.compaction", role: "user" },
      ];
    },
  };
}

/** Summarizes, dropping the oldest item (with its call or result partner) whenever the request overflows. */
async function summarizeTrimming(
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
  model: CompactionSummaryOptions["model"],
): Promise<string> {
  let items = [...history];
  for (;;) {
    try {
      return await ctx.summarize(items, { model, prompt: SUMMARIZATION_PROMPT });
    } catch (error) {
      if (!(error instanceof CompactionOverflowError) || items.length <= 1) throw error;
      items = removeFirstItem(items);
    }
  }
}

/** `remove_first_item`: the oldest message, and the tool results that answer its calls. */
export function removeFirstItem(items: readonly StoredHistoryMessage[]): StoredHistoryMessage[] {
  const [first, ...rest] = items;
  if (first?.role !== "assistant" || typeof first.content === "string") return rest;
  const calls = new Set(
    first.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : [])),
  );
  if (calls.size === 0) return rest;
  return rest.flatMap((message): StoredHistoryMessage[] => {
    if (message.role !== "tool") return [message];
    const content = message.content.filter(
      (part) => part.type !== "tool-result" || !calls.has(part.toolCallId),
    );
    return content.length === 0 ? [] : [{ ...message, content }];
  });
}

/** Person messages, minus earlier summaries, newest first within `budget`; the overflowing one truncated. */
export function retainedUserMessages(
  history: readonly StoredHistoryMessage[],
  budget: number,
  ctx: Pick<CompactionContext, "tokens">,
): StoredHistoryMessage[] {
  const kept: StoredHistoryMessage[] = [];
  let remaining = budget;
  const people = history.filter((message) => message.role === "user" && message.kind === "user");
  for (const message of people.reverse()) {
    const size = ctx.tokens.estimate([message]);
    if (size <= remaining) {
      kept.unshift(message);
      remaining -= size;
      continue;
    }
    const truncated = truncate(message, remaining);
    if (truncated !== undefined) kept.unshift(truncated);
    break;
  }
  return kept;
}

function truncate(message: StoredHistoryMessage, tokens: number): StoredHistoryMessage | undefined {
  if (message.role !== "user" || typeof message.content !== "string" || tokens <= 0) {
    return undefined;
  }
  return { ...message, content: message.content.slice(0, tokens * 4) };
}
