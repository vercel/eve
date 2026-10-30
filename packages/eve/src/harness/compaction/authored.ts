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
import type { ProgramContext } from "#harness/program/program.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type {
  CompactionContext,
  CompactionPhase,
  CompactionReason,
  CompactionRewrite,
  CompactionStrategy,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

/** Where `fixedTail()` finds eve's own compaction on the context eve passes a strategy. */
export const FIXED_TAIL = Symbol.for("eve.compaction.fixedTail");

/** `fixedTail()`'s options. */
export interface FixedTailOptions {
  /** The model that writes the summary. Defaults to the turn model. */
  readonly model?: PublicAgentStaticModelDefinition;
  /** Added to eve's summary prompt, such as what the summary must keep word for word. */
  readonly instructions?: string;
}

type FixedTail = (
  history: readonly StoredHistoryMessage[],
  options: FixedTailOptions,
) => Promise<StoredHistoryMessage[]>;

function rewriteOf(strategy: CompactionStrategy): CompactionRewrite {
  return typeof strategy === "function" ? strategy : strategy.compact;
}

/** Whether the agent's strategy asks eve at `phase`. eve's own compaction asks before a step. */
export function triggersAt(strategy: CompactionStrategy | undefined, phase: CompactionPhase) {
  const phases = (typeof strategy === "object" ? strategy.when?.phases : undefined) ?? ["step"];
  return phases.includes(phase);
}

/** One summary call: eve's checkpoint prompt, or a strategy's request that reuses the turn's prefix. */
export type SummaryCall = (request: {
  readonly messages: ModelMessage[];
  readonly system: string | SystemModelMessage | undefined;
  /** Sent so the request shares the turn's cached prefix; the model can't call them. */
  readonly tools?: ToolSet;
}) => Promise<string>;

/** What an agent's rewrite reads beyond the program's context, while its change is open. */
export interface StrategyContext {
  readonly phase: CompactionContext["phase"];
  readonly reason: CompactionReason;
  readonly sessionId: string;
  readonly changeId: string;
  readonly abortSignal: AbortSignal;
  /** The call's input tokens the threshold allows. */
  readonly threshold: number;
  /** The most history that fits under the threshold. It throws when nothing fits. */
  limit(): number;
  /** Starts the compaction's change, once the strategy is due. */
  open(): Promise<void>;
  readonly model: CompactionContext["model"];
  /** What the turn's request starts with, for a summary that shares its cached prefix. */
  readonly request: {
    readonly instructions: string | SystemModelMessage | undefined;
    readonly tools?: ToolSet;
  };
  /** Writes a summary with `model`, or the compaction model, under the change's summary run. */
  summarizeWith(model?: PublicAgentStaticModelDefinition): SummaryCall;
}

/**
 * An agent's strategy as the history eve asks for before a call: the history as it is until the
 * trigger says it's due, then what `compact` keeps. A manual or overflow compaction always runs.
 */
export function strategyHistory(
  strategy: CompactionStrategy,
  rewrite: StrategyContext,
): (program: ProgramContext) => Promise<readonly HarnessModelMessage[] | undefined> {
  return async (program) => {
    if (rewrite.reason === "automatic") {
      if (!triggersAt(strategy, rewrite.phase as CompactionPhase)) return undefined;
      const inputTokens = program.size?.tokens ?? 0;
      const due = typeof strategy === "object" ? strategy.when?.due : undefined;
      const isDue =
        due === undefined
          ? inputTokens + COMPACTION_PROMPT_OVERHEAD_TOKENS > rewrite.threshold
          : due({
              ...rewrite.model,
              inputTokens,
              phase: rewrite.phase as CompactionPhase,
              threshold: rewrite.threshold,
            });
      if (!isDue) return undefined;
    }
    await rewrite.open();
    const limit = rewrite.limit();
    const ctx: CompactionContext = {
      abortSignal: rewrite.abortSignal,
      change: { changeId: rewrite.changeId },
      checkpoint: (summary) => checkpointHead(summary) as StoredHistoryMessage[],
      model: rewrite.model,
      phase: rewrite.phase,
      reason: rewrite.reason,
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
          const tools = options.reusePrefix === true ? rewrite.request.tools : undefined;
          return await summarize({
            messages: [
              ...(history as ModelMessage[]),
              createFrameworkUserMessage("context.compaction", options.prompt),
            ],
            system:
              options.system === undefined
                ? rewrite.request.instructions
                : options.system || undefined,
            ...(tools !== undefined && { tools }),
          });
        }
        const { conversation, previousCheckpoint } = extractPreviousCheckpoint(
          history as ModelMessage[],
        );
        const prompt = createCompactionPrompt({
          messages: conversation,
          previousCheckpoint,
          transcriptBudgetTokens: limit,
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
    const fixedTail: FixedTail = async (history, options) =>
      (await program.summarize(history as HarnessModelMessage[], {
        ...options,
        tokens: rewrite.threshold,
      })) as StoredHistoryMessage[];
    Object.defineProperty(ctx, FIXED_TAIL, { value: fixedTail });
    return (await rewriteOf(strategy)(program.history as StoredHistoryMessage[], ctx)) as
      | readonly HarnessModelMessage[]
      | undefined;
  };
}

/**
 * The context's view of the rewrite in progress, for `fixedTail()`: undefined when a strategy runs
 * outside eve, as in a unit test that passes its own context.
 */
export function fixedTailOf(ctx: CompactionContext): FixedTail | undefined {
  return (ctx as CompactionContext & { readonly [FIXED_TAIL]?: FixedTail })[FIXED_TAIL];
}
