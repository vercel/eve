import { defineEval, type EveEvalContext, type EveEvalSession, type EveEvalTurn } from "eve/evals";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";

/**
 * Regression coverage for https://github.com/vercel/eve/issues/1201.
 *
 * One model step requests an approval-gated tool and a subagent together.
 * The background task may return its receipt first, but the root turn must
 * retain the approval and re-park instead of resuming the model with an
 * unanswered tool call.
 */
export default defineEval({
  description: "A root approval and subagent call from one model step both survive parking.",
  async test(t) {
    const parked = await t.send(
      [
        `Call the collision-gate tool with marker "${COLLISION_MARKER}" and the collision-child subagent in the same assistant response.`,
        "Do not wait for one call before making the other.",
        `After both results arrive, reply with exactly ${COLLISION_MARKER}.`,
      ].join("\n"),
    );

    parked.calledTool("collision-gate", { count: 1, status: "pending" });
    parked.calledSubagent("collision-child", { count: 1, status: "completed" });
    parked.eventOrder([
      { type: "actions.requested" },
      { type: "subagent.completed" },
      { type: "input.requested" },
      { type: "session.waiting" },
    ]);
    t.requireInputRequest({ display: "confirmation", toolName: "collision-gate" });

    const resumed = await t.respondAll("approve");
    resumed.expectOk();
    const completed = resumed.message?.includes(COLLISION_MARKER)
      ? resumed
      : await waitForMessage(t, t, COLLISION_MARKER);
    completed.messageIncludes(COLLISION_MARKER);

    t.succeeded();
    t.noFailedActions();
    t.calledTool("collision-gate", { count: 1, status: "completed" });
    t.calledSubagent("collision-child", { count: 1, status: "completed" });
  },
});

type SessionCursor = Pick<EveEvalSession, "sessionId" | "state">;

async function waitForMessage(
  t: EveEvalContext,
  initialSession: SessionCursor,
  marker: string,
): Promise<EveEvalTurn> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Mixed approval completion wait has no parent session cursor.");
    }
    const live = t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error("Mixed approval result did not reach the parent after five turns.");
}
