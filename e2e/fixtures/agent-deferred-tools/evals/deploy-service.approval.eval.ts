import { defineEval } from "eve/evals";

import { requireMockModel } from "./mock-only";

export default defineEval({
  description:
    "A deferred workflow tool called through execute asks for approval under its own name, then parks its turn until the run returns.",

  async test(t) {
    requireMockModel(t);

    const parked = await t.send("DEFERRED-DEPLOY Alice asks to deploy the billing service.");
    const session = parked.session;
    parked.expectOk();
    session.requireInputRequest({ optionIds: ["approve", "cancel"], toolName: "deploy_service" });
    parked.calledTool("deploy_service", { count: 1, status: "pending" });
    parked.notCalledTool("execute");

    const approved = await session.respondAll("approve");

    approved.expectOk();
    approved.noFailedActions();
    // The run sees the entry's name as its tool name, not execute.
    approved.calledTool("deploy_service", {
      count: 1,
      output: { deployed: "billing-api", tool: "deploy_service" },
      status: "completed",
    });
    approved.messageIncludes('DEPLOY-RESULT {"deployed":"billing-api","tool":"deploy_service"}');
  },
});
