import { COMPACTION_PROMPT_OVERHEAD_TOKENS } from "#harness/compaction/engine.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { Next, Program, ProgramContext } from "./program.js";

/**
 * eve's own loop. A delivered structured value settles; results the model hasn't read call it
 * again, unless every call ended the turn; otherwise the turn settles with the step's prose, or
 * with none when a call ended it.
 */
export function nativeNext({ turn }: Pick<ProgramContext, "turn">): Next {
  const last = turn?.lastStep;
  if (last === undefined) return { model: {} };
  if (last.output !== undefined) return { settle: { output: last.output } };
  if (turn!.unread && !last.endsTurn) return { model: {} };
  return { settle: { output: last.endsTurn ? null : last.text } };
}

export const nativeProgram: Program = (ctx) => ({ next: () => nativeNext(ctx) });

/**
 * eve's own history: summarized when `session.compact()` asks, or when the call would pass the
 * threshold, a share of the model's window (`agent.ts`'s `compaction.threshold`); otherwise as it
 * is. The summary prompt's own overhead counts against the threshold.
 */
export async function nativeHistory(
  ctx: Pick<ProgramContext, "compact" | "history" | "size" | "summarize">,
  options: {
    /** Without a known window and share, the session's. */
    readonly threshold: number;
    readonly thresholdPercent?: number;
  },
): Promise<readonly HarnessModelMessage[]> {
  if (ctx.history.length === 0) return ctx.history;
  const tokens = nativeThreshold(ctx.size, options);
  if (
    ctx.compact === true ||
    (ctx.size?.tokens ?? 0) + COMPACTION_PROMPT_OVERHEAD_TOKENS > tokens
  ) {
    return await ctx.summarize(ctx.history, { tokens });
  }
  return ctx.history;
}

function nativeThreshold(
  size: ProgramContext["size"],
  options: { readonly threshold: number; readonly thresholdPercent?: number },
): number {
  return size?.window === undefined || options.thresholdPercent === undefined
    ? options.threshold
    : Math.max(1, Math.floor(size.window * options.thresholdPercent));
}
