import { defineEval, type EveEvalContext, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const CHILD_TOKEN = "CHILD_LIMIT_CONTINUED";
const ROOT_RECOVERY_TOKEN = "ROOT_AFTER_DESCENDANT_STOP";

const DELEGATE_PROMPT = [
  "Call the limited-worker subagent exactly once.",
  "Tell it to follow its instructions.",
  `After it returns, reply with exactly ${CHILD_TOKEN} and nothing else.`,
].join(" ");

/**
 * The limited child crosses its one-token budget after calling complete-step.
 * Its continuation prompt must surface on the root session and the answer must
 * route back to the child that minted it.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A descendant session-limit prompt reaches the root; continue resumes the child and stop leaves the root session reusable.",
  timeoutMs: 90_000,
  async test(t) {
    await t.send(DELEGATE_PROMPT);
    const continueSession = await waitForInput(t, t);
    const continueRequest = continueSession.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const rootSessionId = t.sessionId;
    if (rootSessionId === undefined) {
      throw new Error("The root session did not expose its session id.");
    }
    await t.require(
      continueRequest.requestId,
      satisfies(
        (requestId: string) => !requestId.startsWith(`${rootSessionId}:limit:`),
        "continuation request belongs to a descendant session",
      ),
    );

    const resumed = await continueSession.respond([
      {
        optionId: "continue",
        requestId: continueRequest.requestId,
      },
    ]);
    resumed.expectOk();
    const completed = resumed.message?.includes(CHILD_TOKEN)
      ? resumed
      : await waitForMessage(t, continueSession, CHILD_TOKEN);
    completed.messageIncludes(CHILD_TOKEN);
    t.succeeded();
    t.noFailedActions();

    const stopSession = t.newSession();
    await stopSession.send(DELEGATE_PROMPT);
    const blockedStopSession = await waitForInput(t, stopSession);
    const stopRequest = blockedStopSession.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });

    const stopped = await blockedStopSession.respond([
      {
        optionId: "stop",
        requestId: stopRequest.requestId,
      },
    ]);
    stopped.expectOk();
    stopped.notEvent("turn.failed");
    stopped.notEvent("session.failed");
    stopped.notEvent("session.completed");
    stopped.event("turn.cancelled");
    t.check(stopped.status, equals("waiting"));

    const recovered = await stopSession.send(
      `Do not call any tool or subagent. Reply with exactly ${ROOT_RECOVERY_TOKEN} and nothing else.`,
    );
    recovered.expectOk();
    stopSession.succeeded();
    stopSession.calledSubagent("limited-worker", { count: 1 });
    stopSession.messageIncludes(ROOT_RECOVERY_TOKEN);
  },
});

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "requireInputRequest" | "respond" | "send" | "sessionId" | "state"
>;

async function waitForInput(t: EveEvalContext, initial: SessionCursor): Promise<SessionCursor> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInputRequests.length > 0) return session;
    const live = watchNextTurn(t, session, "descendant input wait");
    const turn = await live.result();
    turn.noFailedActions();
    session = live.session;
  }
  throw new Error("Descendant did not surface its session-limit request after five turns.");
}

async function waitForMessage(
  t: EveEvalContext,
  initial: SessionCursor,
  marker: string,
): Promise<EveEvalTurn> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = watchNextTurn(t, session, "descendant completion wait");
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error("Descendant result did not reach the parent after five turns.");
}

function watchNextTurn(t: EveEvalContext, session: SessionCursor, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}
