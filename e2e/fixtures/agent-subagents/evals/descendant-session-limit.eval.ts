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
    const { session } = await t.send(DELEGATE_PROMPT);
    const continueSession = await waitForInput(t, session);
    const continueRequest = continueSession.requireInteraction({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      kind: "budget",
    });
    const rootSessionId = session.id;
    if (rootSessionId === undefined) {
      throw new Error("The root session did not expose its session id.");
    }
    await t.require(
      continueRequest.interactionId,
      satisfies(
        (interactionId: string) =>
          !new RegExp(`^${rootSessionId}:\\d+:limit:`, "u").test(interactionId),
        "continuation request belongs to a descendant session",
      ),
    );

    const resumed = await continueSession.respond([
      {
        optionId: "approve",
        interactionId: continueRequest.interactionId,
      },
    ]);
    resumed.expectOk();
    const completed = resumed.reply?.includes(CHILD_TOKEN)
      ? resumed
      : await waitForMessage(t, continueSession, CHILD_TOKEN);
    completed.expectOk();
    completed.messageIncludes(CHILD_TOKEN);
    t.noFailedCalls();

    const stopSession = await t.session();
    await stopSession.send(DELEGATE_PROMPT);
    const blockedStopSession = await waitForInput(t, stopSession);
    const stopRequest = blockedStopSession.requireInteraction({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      kind: "budget",
    });

    const stopped = await blockedStopSession.respond([
      {
        optionId: "deny",
        interactionId: stopRequest.interactionId,
      },
    ]);
    stopped.expectOk();
    stopped.notEvent("turn.settled", { data: { outcome: "failed" } });
    stopped.notEvent("session.ended", { data: { outcome: "failed" } });
    stopped.notEvent("session.ended", { data: { outcome: "completed" } });
    stopped.event("turn.settled", { data: { outcome: "cancelled" } });
    t.check(stopped.status, equals("cancelled"));

    const recovered = await blockedStopSession.send(
      `Do not call any tool or subagent. Reply with exactly ${ROOT_RECOVERY_TOKEN} and nothing else.`,
    );
    recovered.expectOk();
    stopSession.event("task.started", { data: { name: "limited-worker" }, count: 1 });
    recovered.messageIncludes(ROOT_RECOVERY_TOKEN);
  },
});

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInteractions" | "requireInteraction" | "respond" | "send" | "id" | "state"
>;

async function waitForInput(t: EveEvalContext, initial: SessionCursor): Promise<SessionCursor> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInteractions.length > 0) return session;
    const live = watchNextTurn(t, session, "descendant input wait");
    const turn = await live.result();
    turn.noFailedCalls();
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
    turn.noFailedCalls();
    if (turn.reply?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error("Descendant result did not reach the parent after five turns.");
}

function watchNextTurn(t: EveEvalContext, session: SessionCursor, operation: string) {
  if (session.id === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.attach(session.id, { startIndex: session.state.streamIndex }).watch();
}
