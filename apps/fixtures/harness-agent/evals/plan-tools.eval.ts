import { defineEval } from "eve/evals";

export default defineEval({
  description: "On the pro plan, the harness leaves the agent's remove_seat tool out.",
  async test(t) {
    const turn = await t.send("Please remove bob@example.com's seat from my account.");

    turn.expectOk();
    turn.calledTool("remove_seat", { count: 0 });
    t.succeeded();
  },
});
