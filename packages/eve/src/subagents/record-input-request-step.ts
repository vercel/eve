import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
  type AnswerHookRoute,
} from "#harness/proxy-input-requests.js";

/** Commits response routes before publishing can invoke a failing authored hook. */
export async function recordProxyInputRequestStep(input: {
  readonly answerHook?: AnswerHookRoute;
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const entries = toProxyInputRequestEntries(input.hookPayload);
  const state = upsertProxyInputRequestState({
    entries:
      input.answerHook === undefined
        ? entries
        : entries.map(([requestId, route]) => [
            requestId,
            { ...route, answerHook: input.answerHook },
          ]),
    forChildContinuationToken: input.hookPayload.childContinuationToken,
    state: session.state,
  });
  return {
    sessionState: replaceDurableSessionSnapshot({
      session: { ...session, state },
      state: input.sessionState,
    }),
  };
}
