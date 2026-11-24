import { fixedTail } from "./strategies.js";
import {
  OPENAI_DIRECT_PROVIDER,
  endsWithOpenAICompaction,
} from "#harness/compaction/openai-item.js";
import { createLogger, logError } from "#internal/logging.js";
import type { CompactionRewrite } from "#shared/compaction-strategy.js";

const log = createLogger("harness.compaction");

/**
 * Compacts with OpenAI's own compaction instead of a text summary. eve sends the turn's request
 * with OpenAI's `compaction_trigger`, and OpenAI answers with an encrypted record of what the
 * history held. eve stores that record as the history and sends it back with every later request,
 * so the model keeps its working state where a summary would drop it.
 *
 * It needs the OpenAI Responses API called directly, with `openai("gpt-...")`. On any other model,
 * and when the call fails, the compaction falls back to `fixedTail()`'s text summary and logs why.
 * The record is unreadable to other providers: a session that switches models after a native
 * compaction logs a warning on each request.
 *
 * ```ts
 * compaction: { compact: openaiCompaction() },
 * ```
 */
export function openaiCompaction(): CompactionRewrite {
  const fallback = fixedTail();
  return async (history, ctx) => {
    if (ctx.model.provider !== OPENAI_DIRECT_PROVIDER) {
      log.warn(
        `openaiCompaction() needs the OpenAI Responses API called directly; the model is ${ctx.model.provider} ${ctx.model.modelId}, so eve summarizes as text instead.`,
        { sessionId: ctx.session.id },
      );
      return await fallback(history, ctx);
    }
    if (endsWithOpenAICompaction(history)) return undefined;
    try {
      return await ctx.send(history, {
        providerOptions: { openai: { compactionTrigger: true } },
      });
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      logError(log, "OpenAI compaction failed; eve summarizes as text instead", error, {
        sessionId: ctx.session.id,
      });
      return await fallback(history, ctx);
    }
  };
}
