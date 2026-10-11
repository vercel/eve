import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

const MARKER = "RELEASE-PAIR-DONE-4T8Q";

/**
 * Alice asks the agent to ship a release through a subagent that needs two
 * approvals at once. On a text-only channel she answers them one message at a
 * time: each typed reply answers the first open approval only.
 */
export default defineEval({
  tags: ["session-inbox"],
  description: "Typed replies at the parent answer a subagent's two approvals one at a time.",
  timeoutMs: 90_000,

  async test(t) {
    const started = await t.send(
      "Call the release-pair subagent exactly once and relay its final result when it completes.",
    );
    const blocked = await waitForInputs(t, started.session, ["deploy_release", "publish_notes"]);

    const deployRequestId = blocked.pendingInputRequests[0]?.requestId;
    // The reply answers only the first approval. The subagent decides it, and the parent relays
    // its settlement before showing the next prompt; Alice replies once she sees that one.
    const approved = await blocked.send("approve");
    approved.noFailedActions();
    const settledInTurn = approved.events.some(
      (event) => event.type === "approval.settled" && event.data.requestId === deployRequestId,
    );
    if (!settledInTurn) {
      await watchNextTurn(t, approved.session, "deploy approval settlement").waitForEvent(
        "approval.settled",
        { data: { outcome: "approved", requestId: deployRequestId } },
      );
    }
    const resolved = approved.events.flatMap((event) =>
      event.type === "input.resolved" ? event.data.resolutions : [],
    );
    if (resolved.some((resolution) => resolution.requestId !== deployRequestId)) {
      throw new Error(`The first reply resolved ${JSON.stringify(resolved)}.`);
    }

    const cancelled = await approved.session.send("cancel");
    cancelled.noFailedActions();
    const completed = cancelled.message?.includes(MARKER)
      ? cancelled
      : await waitForMessage(t, approved.session, MARKER);
    completed.messageIncludes('deploy_release={"deployed":true}');
    if (completed.message?.includes('"published":true') === true) {
      throw new Error("The typed cancel ran publish_notes instead of denying it.");
    }

    t.calledSubagent("release-pair", { status: "completed", count: 1 });
  },
});

/** Waits until exactly `toolNames` have open approvals on the parent, in that order. */
async function waitForInputs(
  t: EveEvalContext,
  initialSession: EveEvalSession,
  toolNames: readonly string[],
): Promise<EveEvalSession> {
  let session = initialSession;
  const pending = () => session.pendingInputRequests.map((request) => request.action.toolName);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (JSON.stringify(pending()) === JSON.stringify(toolNames)) return session;
    const live = watchNextTurn(t, session, "subagent input wait");
    const turn = await live.result();
    turn.noFailedActions();
    session = live.session;
  }
  throw new Error(
    `Expected open approvals ${JSON.stringify(toolNames)}, saw ${JSON.stringify(pending())}.`,
  );
}

async function waitForMessage(
  t: EveEvalContext,
  initialSession: EveEvalSession,
  marker: string,
): Promise<EveEvalTurn> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = watchNextTurn(t, session, "subagent completion wait");
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error("Subagent result did not reach the parent after five turns.");
}

function watchNextTurn(t: EveEvalContext, session: EveEvalSession, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}
