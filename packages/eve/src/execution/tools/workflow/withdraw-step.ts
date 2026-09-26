import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { emitQuestionResolutions } from "#execution/proxied-deliver-step.js";
import { getProxyInputRequests, retireProxyInputRequests } from "#harness/proxy-input-requests.js";

/**
 * Retires a question its run withdrew and reports it `cancelled`, so channels
 * stop offering it. A question already answered has no route left to retire.
 */
export async function withdrawWorkflowToolRunQuestionStep(input: {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const route = getProxyInputRequests(session.state).get(input.requestId);
  if (route?.answerHook?.runId !== input.runId) return { sessionState: input.sessionState };

  await emitQuestionResolutions({
    resolutions: [{ kind: "question", outcome: "cancelled", requestId: input.requestId }],
    sessionState: session.state,
    sessionWritable: input.sessionWritable,
  });
  const retired = retireProxyInputRequests(session, [input.requestId]);
  return {
    sessionState: replaceDurableSessionSnapshot({ session: retired, state: input.sessionState }),
  };
}
