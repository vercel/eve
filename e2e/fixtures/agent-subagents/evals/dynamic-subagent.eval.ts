import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Dynamic subagents are advertised when their resolver returns an agent config and omitted when it returns nil.",
  async test(t) {
    const selected = await t.send("Call conditional-marker exactly once.");
    selected.expectOk();
    const sessionId = selected.sessionId;
    if (sessionId === undefined) throw new Error("Dynamic subagent turn has no session id.");
    const completed = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(t),
    });
    const completionTurn = await completed.result();
    completionTurn.expectOk();
    completionTurn.messageIncludes("DYNAMIC_SUBAGENT_ENABLED");
    t.calledSubagent("conditional-marker", { count: 1 });

    const omitted = await completed.session.send("Call omitted-marker exactly once.");

    omitted.notEvent("subagent.called", { data: { name: "omitted-marker" } });
    omitted.noFailedActions();
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Dynamic subagent turn has no stream index.");
  return streamIndex;
}
