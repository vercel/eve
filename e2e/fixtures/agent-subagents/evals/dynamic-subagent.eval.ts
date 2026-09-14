import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send("Call conditional-marker exactly once.");
    selected.expectOk();
    selected.event("subagent.completed", {
      count: 1,
      data: { backgroundTask: { status: "working" }, subagentName: "conditional-marker" },
    });
    const completed = await waitForMessage(t, t, "DYNAMIC_SUBAGENT_ENABLED");

    const omitted = await completed.send("Call omitted-marker exactly once.");

    omitted.notEvent("subagent.called", { data: { name: "omitted-marker" } });
    omitted.noFailedActions();
  },
});

async function waitForMessage(
  t: EveEvalContext,
  initial: Pick<EveEvalSession, "send" | "sessionId" | "state">,
  marker: string,
): Promise<Pick<EveEvalSession, "send" | "sessionId" | "state">> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("Dynamic subagent turn has no session cursor.");
    }
    const live = t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
    const turn = await live.result();
    turn.expectOk();
    if (turn.message?.includes(marker) === true) return live.session;
    session = live.session;
  }
  throw new Error(`Dynamic subagent result did not include ${marker} after five turns.`);
}
