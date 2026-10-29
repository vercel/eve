import type { ModelMessage } from "ai";

import {
  checkpointHead,
  compactMessages,
  type CompactionSummarizer,
  extractPreviousCheckpoint,
} from "#harness/compaction/engine.js";
import { CompactionOverLimitError } from "#harness/compaction/over-limit-error.js";
import {
  COMPACTION_CHECKPOINT_MARKER,
  createCompactionPrompt,
} from "#harness/compaction/prompt.js";
import type { HistoryRewrite } from "#harness/compaction/step.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  isUserModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type { CompactionContext, CompactionStrategy } from "#shared/compaction-strategy.js";
import type { HistoryMessage } from "#shared/history-message.js";

/** Where `fixedTail()` finds eve's default rewrite on the context eve passes a strategy. */
export const FIXED_TAIL = Symbol.for("eve.compaction.fixedTail");

/** `fixedTail()`'s options. */
export interface FixedTailOptions {
  /** The model that writes the summary. Defaults to the turn model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /** Added to eve's summary prompt, such as what the summary must keep word for word. */
  readonly instructions?: string;
}

type FixedTail = (
  history: readonly HistoryMessage[],
  options: FixedTailOptions,
) => Promise<HistoryMessage[]>;

/** An agent's `compaction.compact` as eve runs it: under the change, checked before it applies. */
export function authoredRewrite(strategy: CompactionStrategy): HistoryRewrite {
  return async (messages, rewrite) => {
    const reason = rewrite.force ? "manual" : "automatic";
    const summarizerFor = (options?: {
      readonly instructions?: string;
      readonly model?: PublicAgentStaticModelDefinition;
    }): CompactionSummarizer => {
      const summarize = rewrite.summarizeWith(options?.model);
      const { instructions } = options ?? {};
      return instructions === undefined
        ? summarize
        : (prompt) => summarize({ ...prompt, system: `${prompt.system}\n\n${instructions}` });
    };
    const ctx: CompactionContext = {
      abortSignal: rewrite.abortSignal,
      change: { changeId: rewrite.changeId },
      checkpoint: (summary) => checkpointHead(summary) as HistoryMessage[],
      reason,
      session: { id: rewrite.sessionId },
      summarize: async (history, options) => {
        const { conversation, previousCheckpoint } = extractPreviousCheckpoint(
          history as ModelMessage[],
        );
        const prompt = createCompactionPrompt({
          messages: conversation,
          previousCheckpoint,
          transcriptBudgetTokens: rewrite.config.threshold,
        });
        return await summarizerFor(options)({
          messages: [createFrameworkUserMessage("context.compaction", prompt.prompt)],
          system: prompt.system,
        });
      },
      tokens: {
        estimate: (history) => estimateTokens(history as ModelMessage[]),
        limit: rewrite.config.threshold,
      },
    };
    const fixedTail: FixedTail = async (history, options) =>
      (await compactMessages(
        [...(history as ModelMessage[])],
        rewrite.config,
        summarizerFor(options),
        rewrite.force,
        rewrite.historyTokens,
      )) as HistoryMessage[];
    Object.defineProperty(ctx, FIXED_TAIL, { value: fixedTail });

    const result = await strategy(messages as HistoryMessage[], ctx);
    if (result === undefined) {
      if (reason === "automatic") {
        throw new CompactionOverLimitError(
          `The compaction strategy removed nothing, but the history (~${Math.round(estimateTokens(messages))} tokens) is over the compaction limit (~${Math.round(rewrite.config.threshold)}).`,
        );
      }
      return undefined;
    }
    return checkCompactedHistory(messages, result as ModelMessage[], {
      automatic: reason === "automatic",
      limit: rewrite.config.threshold,
    });
  };
}

/**
 * A strategy's result, checked: every user message keeps its kind, no call loses its result, a
 * checkpoint opens the history, the turn's input survives, and an automatic result fits.
 */
export function checkCompactedHistory(
  before: readonly HarnessModelMessage[],
  after: readonly ModelMessage[],
  input: { readonly automatic: boolean; readonly limit: number },
): HarnessModelMessage[] {
  let messages: HarnessModelMessage[];
  try {
    messages = validateHarnessModelMessages(after);
  } catch {
    throw new Error(
      "The compaction strategy returned a user message without a kind. Keep the messages eve passed it, or build a checkpoint with ctx.checkpoint().",
    );
  }
  const answered = (history: readonly ModelMessage[]) => {
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const message of history) {
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type === "tool-call" && part.providerExecuted !== true) calls.add(part.toolCallId);
        if (part.type === "tool-result" && message.role === "tool") results.add(part.toolCallId);
      }
    }
    return { calls, results };
  };
  const was = answered(before);
  const now = answered(messages);
  for (const callId of now.calls) {
    if (!now.results.has(callId) && (was.results.has(callId) || !was.calls.has(callId))) {
      throw new Error(
        `The compaction strategy kept tool call ${callId} but dropped its result. Keep or remove a call together with its result; turns() from "eve/compaction" groups them.`,
      );
    }
  }
  for (const callId of now.results) {
    if (!now.calls.has(callId)) {
      throw new Error(
        `The compaction strategy kept the result of tool call ${callId} but dropped the call. Keep or remove a call together with its result; turns() from "eve/compaction" groups them.`,
      );
    }
  }
  const checkpoints = messages.flatMap((message, index) =>
    isCheckpointMarker(message) ? [index] : [],
  );
  if (checkpoints.some((index) => index !== 0) || checkpoints.length > 1) {
    throw new Error(
      "The compaction strategy placed a checkpoint after other messages. Put ctx.checkpoint() first, followed by the history you keep.",
    );
  }
  if (input.automatic && hasTurnInput(before) && !hasTurnInput(messages)) {
    throw new Error(
      "The compaction strategy removed the turn's input. Keep the latest user message: the model answers it next.",
    );
  }
  const size = estimateTokens(messages);
  if (input.automatic && size > input.limit) {
    throw new CompactionOverLimitError(
      `The compaction strategy returned ~${Math.round(size)} tokens of history; the limit is ~${Math.round(input.limit)}.`,
    );
  }
  return messages;
}

function isCheckpointMarker(message: ModelMessage): boolean {
  return (
    isUserModelMessage(message) &&
    message.kind === "context.compaction" &&
    message.content === COMPACTION_CHECKPOINT_MARKER
  );
}

function hasTurnInput(history: readonly ModelMessage[]): boolean {
  return history.some((message) => isUserModelMessage(message) && message.kind === "user");
}

/**
 * The context's view of the rewrite in progress, for `fixedTail()`: undefined when a strategy runs
 * outside eve, as in a unit test that passes its own context.
 */
export function fixedTailOf(ctx: CompactionContext): FixedTail | undefined {
  return (ctx as CompactionContext & { readonly [FIXED_TAIL]?: FixedTail })[FIXED_TAIL];
}
