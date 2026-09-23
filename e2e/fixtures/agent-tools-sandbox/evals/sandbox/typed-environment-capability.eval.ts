import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Sandbox: ctx.getSandbox(environment) exposes the configured environment's capabilities.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send(
      "Ask the `deny-all` subagent with message: Verify the configured environment sandbox capability.",
    );
    turn.expectOk();
    const completed = await t.target
      .watchTurn(turn.sessionId, { startIndex: requireStreamIndex(turn.session) })
      .result();
    completed.expectOk();
    const called = completed.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "deny-all",
    );
    if (called?.type !== "subagent.called") {
      throw new Error("Typed sandbox turn did not call the deny-all subagent.");
    }

    const childTurn = await t.target.watchTurn(called.data.childSessionId).result();
    childTurn.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });
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
