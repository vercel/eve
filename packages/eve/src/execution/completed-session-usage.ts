import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { getTurnUsageState } from "#harness/turn-tag-state.js";
import { createLogger } from "#internal/logging.js";
import type { Usage } from "#shared/usage.js";

const log = createLogger("execution.completed-session-usage");

/**
 * Reads a completed session's lifetime token totals from its durable state,
 * projected to the usage shape carried on subagent results and remote session
 * callbacks. Reads the nested session totals, not the flat final-turn fields —
 * the two only coincide for single-turn children. Best-effort: a failed read
 * returns `undefined` so terminal delivery never blocks on usage collection.
 */
export async function readCompletedSessionUsage(
  sessionState: DurableSessionState,
): Promise<Usage | undefined> {
  try {
    const durable = await readDurableSession(sessionState);
    const turn = getTurnUsageState(durable.state);
    if (turn === undefined) {
      return undefined;
    }
    return {
      cacheReadTokens: turn.session.cacheReadTokens,
      cacheWriteTokens: turn.session.cacheWriteTokens,
      inputTokens: turn.session.inputTokens,
      outputTokens: turn.session.outputTokens,
    };
  } catch (error) {
    log.warn("failed to read completed session usage", { error });
    return undefined;
  }
}
