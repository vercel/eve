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
    const started = turn.events.find(
      (event) => event.type === "task.started" && event.data.name === "deny-all",
    );
    if (started?.type !== "task.started" || started.data.child === undefined) {
      throw new Error("Typed sandbox turn did not call the deny-all subagent.");
    }

    const childTurn = await t.target.watchTurn(started.data.child.sessionId).result();
    childTurn.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });
    childTurn.calledTool("verify-typed-sandbox", { output: { blocked: true } });
  },
});
