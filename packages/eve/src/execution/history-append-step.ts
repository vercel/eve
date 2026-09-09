import { appendSessionHistory, HistoryAppendError } from "#harness/history-append.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { HistoryMessage } from "#shared/history-message.js";
import type { HistoryAppendCommandResult } from "#channel/types.js";

/** Applies an acknowledged history append at a durable session boundary. */
export async function appendHistoryStep(input: {
  readonly messages: readonly HistoryMessage[];
  readonly operationId: string;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly result: HistoryAppendCommandResult;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  try {
    const durable = await readDurableSession(input.sessionState);
    const appended = appendSessionHistory({
      messages: input.messages,
      operationId: input.operationId,
      session: durable,
    });
    return {
      result: { outcome: appended.outcome, sessionId: durable.sessionId, status: "ok" },
      sessionState: replaceDurableSessionSnapshot({
        session: appended.session,
        state: input.sessionState,
      }),
    };
  } catch (error) {
    if (!(error instanceof HistoryAppendError)) throw error;
    return {
      result: { code: error.code, message: error.message, status: "error" },
      sessionState: input.sessionState,
    };
  }
}
