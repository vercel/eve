import { defineEval } from "eve/evals";

export default defineEval({
  description: "Routes an incident request to the hidden incident specialist and grades the brief.",
  async test(t) {
    await t.send(
      "Our checkout API is returning 500s for some customers. Create an incident brief with impact, mitigation, owner, and next update time.",
    );

    t.succeeded();
    t.calledTool("route_work");
    t.calledSubagent("incident-commander");
    t.judge(
      "The response clearly separates known impact from unknowns and proposes a concrete next update.",
    ).atLeast(0.8);
  },
});
