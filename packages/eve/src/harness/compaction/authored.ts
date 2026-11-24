import type { ModelMessage, SystemModelMessage, ToolSet } from "ai";

import {
  checkpointHead,
  COMPACTION_PROMPT_OVERHEAD_TOKENS,
  extractPreviousCheckpoint,
} from "#harness/compaction/engine.js";
import { createCompactionPrompt } from "#harness/compaction/prompt.js";
import { CompactionOverflowError } from "#harness/compaction/overflow-error.js";
import { isContextOverflowError } from "#harness/model-call/errors.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type {
  CompactionContext,
  CompactionEvent,
  CompactionReason,
  CompactionStrategy,
  ResolvedCompactionStrategy,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

/** What `fixedTail()` can change: the model that writes its summary, and the instructions added to the checkpoint prompt. */
export interface FixedTailOptions {
  /** The model that writes the summary, when it isn't the turn's model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /** Added to eve's checkpoint prompt, such as what the summary must keep word for word. */
  readonly instructions?: string;
}

type FixedTail = (
  history: readonly StoredHistoryMessage[],
  options: FixedTailOptions,
) => Promise<StoredHistoryMessage[]>;

const fixedTails = new WeakMap<CompactionContext, FixedTail>();

export function resolveStrategy(
  strategy: CompactionStrategy | undefined,
): ResolvedCompactionStrategy | undefined {
  if (strategy === undefined) return undefined;
  if (typeof strategy === "function") {
    return { compact: strategy, when: { "model.requested": true } };
  }
  return { compact: strategy.compact, when: strategy.when ?? { "model.requested": true } };
}

export function triggersAt(
  strategy: ResolvedCompactionStrategy | undefined,
  event: CompactionEvent,
): boolean {
  return strategy !== undefined && strategy.when[event] !== undefined;
}

export interface RequestPrefix {
  readonly instructions: RequestInstructions;
  readonly tools?: ToolSet;
}

export type RequestInstructions = string | SystemModelMessage | SystemModelMessage[] | undefined;

export type SummaryCall = (request: {
  readonly messages: ModelMessage[];
  readonly system: RequestInstructions;
}) => Promise<string>;

export type Summarize = (
  history: readonly HarnessModelMessage[],
  options: {
    readonly model?: PublicAgentStaticModelDefinition;
    readonly instructions?: string;
  },
) => Promise<HarnessModelMessage[]>;

export interface StrategyInput {
  readonly history: readonly HarnessModelMessage[];
  readonly inputTokens: number;
  readonly summarize: Summarize;
}

export interface StrategyContext {
  readonly event: CompactionContext["event"];
  readonly reason: CompactionReason;
  readonly sessionId: string;
  readonly changeId: string;
  readonly abortSignal: AbortSignal;
  readonly threshold: number;
  readonly limit: number;
  open(): Promise<void>;
  readonly model: Pick<CompactionContext["model"], "contextWindowTokens" | "maxOutputTokens">;
  identity(): Promise<Pick<CompactionContext["model"], "provider" | "modelId">>;
  request(): Promise<RequestPrefix>;
  summarizeWith(model?: PublicAgentStaticModelDefinition): SummaryCall;
  send(
    history: readonly HarnessModelMessage[],
    providerOptions: Parameters<CompactionContext["send"]>[1]["providerOptions"],
  ): Promise<HarnessModelMessage[]>;
}

export function strategyHistory(
  strategy: ResolvedCompactionStrategy,
  rewrite: StrategyContext,
): (input: StrategyInput) => Promise<readonly HarnessModelMessage[] | undefined> {
  return async (input) => {
    if (rewrite.reason === "automatic") {
      const trigger = rewrite.event === undefined ? undefined : strategy.when[rewrite.event];
      if (trigger === undefined) return undefined;
      const { inputTokens } = input;
      const isDue =
        trigger === true
          ? inputTokens + COMPACTION_PROMPT_OVERHEAD_TOKENS > rewrite.threshold
          : trigger({
              contextWindowTokens: rewrite.model.contextWindowTokens,
              maxOutputTokens: rewrite.model.maxOutputTokens,
              inputTokens,
              threshold: rewrite.threshold,
            });
      if (!isDue) return undefined;
    }
    await rewrite.open();
    const identity = await rewrite.identity();
    const { limit } = rewrite;
    const ctx: CompactionContext = {
      abortSignal: rewrite.abortSignal,
      change: { changeId: rewrite.changeId },
      checkpoint: (summary) => checkpointHead(summary) as StoredHistoryMessage[],
      model: { ...rewrite.model, ...identity },
      event: rewrite.event,
      reason: rewrite.reason,
      send: async (history, { providerOptions }) =>
        (await rewrite.send(
          history as HarnessModelMessage[],
          providerOptions,
        )) as StoredHistoryMessage[],
      session: { id: rewrite.sessionId },
      summarize: async (history, options = {}) => {
        const call = rewrite.summarizeWith(options.model);
        const summarize: SummaryCall = async (request) => {
          try {
            return await call(request);
          } catch (error) {
            if (isContextOverflowError(error)) throw new CompactionOverflowError({ cause: error });
            throw error;
          }
        };
        if (options.prompt !== undefined) {
          return await summarize({
            messages: [
              ...(history as ModelMessage[]),
              createFrameworkUserMessage("context.compaction", options.prompt),
            ],
            system:
              options.system === undefined
                ? (await rewrite.request()).instructions
                : options.system || undefined,
          });
        }
        const { conversation, previousCheckpoint } = extractPreviousCheckpoint(
          history as ModelMessage[],
        );
        const prompt = createCompactionPrompt({
          messages: conversation,
          previousCheckpoint,
          transcriptBudgetTokens: Math.min(limit, rewrite.threshold),
        });
        return await summarize({
          messages: [createFrameworkUserMessage("context.compaction", prompt.prompt)],
          system:
            options.instructions === undefined
              ? prompt.system
              : `${prompt.system}\n\n${options.instructions}`,
        });
      },
      tokens: {
        estimate: (history) => estimateTokens(history as ModelMessage[]),
        limit,
      },
    };
    fixedTails.set(
      ctx,
      async (history, options) =>
        (await input.summarize(
          history as HarnessModelMessage[],
          options,
        )) as StoredHistoryMessage[],
    );
    return (await strategy.compact(input.history as StoredHistoryMessage[], ctx)) as
      | readonly HarnessModelMessage[]
      | undefined;
  };
}

export function fixedTailOf(ctx: CompactionContext): FixedTail | undefined {
  return fixedTails.get(ctx);
}
