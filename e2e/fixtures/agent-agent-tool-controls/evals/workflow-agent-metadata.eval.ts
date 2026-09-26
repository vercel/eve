import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "ctx.agents exposes the root copy and hidden declared specialists.",
  async test(t) {
    const turn = await t.send("E2E_INSPECT_WORKFLOW_AGENTS");

    turn.expectOk();
    turn.messageIncludes("Coordinate specialist work and delegate focused subtasks.");
    turn.messageIncludes("Investigate, analyze, and explain questions without changing systems.");
    turn.messageIncludes("Execute operational changes to systems and deployments.");
    await t.require(
      Object.keys(JSON.parse(turn.message ?? "{}")).sort(),
      equals(["agent", "operator", "researcher"]),
    );
    turn.calledTool("inspect-agents", { count: 1 });
    turn.notEvent("agent.started");
    t.succeeded();
    t.noFailedActions();
  },
});
