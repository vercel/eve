import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Sandbox: ctx.getSandbox(environment) exposes the configured environment's capabilities.",
  async test(t) {
    const turn = await t.send(
      "Ask the `deny-all` subagent with message: Verify the configured environment sandbox capability.",
    );
    turn.expectOk();
    const started = turn.events.find(
      (event) => event.type === "agent.started" && event.data.name === "deny-all",
    );
    if (started?.type !== "agent.started") {
      throw new Error("Typed sandbox turn did not call the deny-all subagent.");
    }

    const childTurn = await t.target.watchTurn(started.data.sessionId).result();
    childTurn.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });
    childTurn.calledTool("verify-typed-sandbox", { output: { blocked: true } });
  },
});
