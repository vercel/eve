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
    const sessionId = turn.sessionId;
    if (sessionId === undefined) throw new Error("Typed sandbox turn has no session id.");
    const completed = await t.target
      .watchTurn(sessionId, { startIndex: requireStreamIndex(turn.session) })
      .result();
    completed.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });

    // Real models paraphrase the child's report, so assert on the tool result
    // inside the child session rather than on the parent's final message.
    const called = [...turn.events, ...completed.events].find(
      (event) => event.type === "subagent.called" && event.data.name === "deny-all",
    );
    if (called?.type !== "subagent.called") throw new Error("deny-all was not delegated.");
    const child = await t.target.watchTurn(called.data.childSessionId).result();
    child.expectOk();
    child.calledTool("verify-typed-sandbox", { output: { blocked: true }, status: "completed" });
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Typed sandbox turn has no stream index.");
  return streamIndex;
}
