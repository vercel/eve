import type { ModelMessage, SystemModelMessage, ToolSet } from "ai";

import { checkpointHead, extractPreviousCheckpoint } from "#harness/compaction/engine.js";
import { createCompactionPrompt } from "#harness/compaction/prompt.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { ProgramContext } from "#harness/program/program.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { PublicAgentStaticModelDefinition } from "#shared/agent-definition.js";
import type {
  CompactionContext,
  CompactionMeasure,
  CompactionPhase,
  CompactionRewrite,
  CompactionStrategy,
} from "#shared/compaction-strategy.js";
import type { HistoryMessage } from "#shared/history-message.js";

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
  history: readonly HistoryMessage[],
  options: FixedTailOptions,
) => Promise<HistoryMessage[]>;

function rewriteOf(strategy: CompactionStrategy): CompactionRewrite {
  return typeof strategy === "function" ? strategy : strategy.compact;
}

/** Whether the agent's strategy asks eve at `phase`. eve's own compaction asks before a step. */
export function triggersAt(strategy: CompactionStrategy | undefined, phase: CompactionPhase) {
  const phases = (typeof strategy === "object" ? strategy.when?.phases : undefined) ?? ["step"];
  return phases.includes(phase);
}

/** The strategy's `due`, or `threshold`'s verdict when it has none. */
export function isDue(
  strategy: CompactionStrategy | undefined,
  measure: CompactionMeasure,
  overThreshold: boolean,
): boolean {
  const due = typeof strategy === "object" ? strategy.when?.due : undefined;
  return due === undefined ? overThreshold : due(measure);
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
  readonly sessionId: string;
  readonly changeId: string;
  readonly abortSignal: AbortSignal;
  /** The most history that fits under the threshold. */
  readonly limit: number;
  /** What the turn's request starts with, for a summary that shares its cached prefix. */
  readonly request: {
    readonly instructions: string | SystemModelMessage | undefined;
    readonly tools?: ToolSet;
  };
  /** Writes a summary with `model`, or the compaction model, under the change's summary run. */
  summarizeWith(model?: PublicAgentStaticModelDefinition): SummaryCall;
}

/** An agent's `compaction.compact` as the history eve keeps where it has to shrink it. */
export function strategyHistory(
  strategy: CompactionStrategy,
  rewrite: StrategyContext,
): (program: ProgramContext) => Promise<readonly HarnessModelMessage[] | undefined> {
  return async (program) => {
    const compaction = program.compaction!;
    const ctx: CompactionContext = {
      abortSignal: rewrite.abortSignal,
      change: { changeId: rewrite.changeId },
      checkpoint: (summary) => checkpointHead(summary) as HistoryMessage[],
      phase: rewrite.phase,
      reason: compaction.reason,
      session: { id: rewrite.sessionId },
      summarize: async (history, options = {}) => {
        const summarize = rewrite.summarizeWith(options.model);
        if (options.prompt !== undefined) {
          const tools = options.reusePrefix === true ? rewrite.request.tools : undefined;
          return await summarize({
            messages: [
              ...(history as ModelMessage[]),
              createFrameworkUserMessage("context.compaction", options.prompt),
            ],
            system: rewrite.request.instructions,
            ...(tools !== undefined && { tools }),
          });
        }
        const { conversation, previousCheckpoint } = extractPreviousCheckpoint(
          history as ModelMessage[],
        );
        const prompt = createCompactionPrompt({
          messages: conversation,
          previousCheckpoint,
          transcriptBudgetTokens: rewrite.limit,
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
        limit: rewrite.limit,
      },
    };
    const fixedTail: FixedTail = async (history, options) =>
      (await compaction.native(history as HarnessModelMessage[], options)) as HistoryMessage[];
    Object.defineProperty(ctx, FIXED_TAIL, { value: fixedTail });
    return (await rewriteOf(strategy)(program.history as HistoryMessage[], ctx)) as
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
