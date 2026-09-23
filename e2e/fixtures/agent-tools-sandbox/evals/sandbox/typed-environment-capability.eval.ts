import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Sandbox: ctx.getSandbox(environment) exposes the configured environment's capabilities.",
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session();
    const parent = await session.start(
      "Ask the `deny-all` subagent with message: Verify the configured environment sandbox capability.",
    );
    const called = await parent.waitForEvent("subagent.called", {
      data: { name: "deny-all" },
    });
    const child = t.target.watchTurn(called.data.childSessionId).result();
    const turn = await parent.result();
    turn.expectOk();
    const sessionId = turn.sessionId;
    if (sessionId === undefined) throw new Error("Typed sandbox turn has no session id.");
    const completed = await t.target
      .watchTurn(sessionId, { startIndex: requireStreamIndex(turn.session) })
      .result();
    completed.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });
    const childTurn = await child;
    childTurn.expectOk();
    childTurn.calledTool("verify-typed-sandbox", { output: { blocked: true } });
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Typed sandbox turn has no stream index.");
  return streamIndex;
}
