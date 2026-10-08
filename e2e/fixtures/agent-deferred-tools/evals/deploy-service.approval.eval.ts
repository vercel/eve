import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A deferred workflow tool called through eve__execute asks for approval under its own name, then parks its turn until the run returns.",

  async test(t) {
    requireMockModel(t);

    const parked = await t.send("DEFERRED-DEPLOY Alice asks to deploy the billing service.");
    const session = parked.session;
    parked.expectOk();
    session.requireInputRequest({ optionIds: ["approve", "cancel"], toolName: "deploy_service" });
    parked.calledTool("deploy_service", { count: 1, status: "pending" });
    // notCalledTool rejects EXECUTE_TOOL because no call is reported under it, so check the raw actions.
    parked.eventsSatisfy(`no action is reported under ${EXECUTE_TOOL}`, (events) =>
      events.every(
        (event) =>
          event.type !== "actions.requested" ||
          event.data.actions.every(
            (action) => !("toolName" in action) || action.toolName !== EXECUTE_TOOL,
          ),
      ),
    );

    const approved = await session.respondAll("approve");

    approved.expectOk();
    approved.noFailedActions();
    // The run sees the entry's name as its tool name, not eve__execute.
    approved.calledTool("deploy_service", {
      count: 1,
      output: { deployed: "billing-api", tool: "deploy_service" },
      status: "completed",
    });
    approved.messageIncludes('DEPLOY-RESULT {"deployed":"billing-api","tool":"deploy_service"}');
  },
});
