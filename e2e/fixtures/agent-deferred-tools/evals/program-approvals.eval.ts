import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/** The id the scripted model gives its `eve__execute` call; nested calls take `<id>/<n>`. */
const PROGRAM_CALL = "deploy-program";

export default defineEval({
  description:
    "Two calls a program starts together ask for approval together, each under its own tool's name and nested call id; the approved one runs as a workflow run the program waits on, and the denied one rejects in the program.",

  async test(t) {
    requireMockModel(t);

    const parked = await t.send(
      "PROGRAM-DEPLOY Alice asks to deploy the billing and ledger services.",
    );
    const session = parked.session;
    parked.expectOk();
    // Both requests are pending at once, each about the nested call that needs it, not the program.
    const requests = [...session.pendingInteractions].sort((left, right) =>
      (left.call?.callId ?? "").localeCompare(right.call?.callId ?? ""),
    );
    await t.require(
      requests.map((request) => request.call),
      equals([
        { callId: `${PROGRAM_CALL}/1`, input: { service: "billing-api" }, name: "deploy_service" },
        { callId: `${PROGRAM_CALL}/2`, input: { service: "ledger-api" }, name: "deploy_service" },
      ]),
    );
    const [billing, ledger] = requests as [(typeof requests)[number], (typeof requests)[number]];
    parked.calledTool("deploy_service", { count: 2, status: "pending" });
    parked.calledTool(EXECUTE_TOOL, { count: 1, status: "pending" });

    const decided = await session.respond([
      { interactionId: billing.interactionId, optionId: "approve" },
      { interactionId: ledger.interactionId, optionId: "deny" },
    ]);

    decided.expectOk();
    // The approved deployment runs under the entry's name, and the program resumes with its result.
    decided.calledTool("deploy_service", {
      count: 1,
      input: { service: "billing-api" },
      output: { deployed: "billing-api", tool: "deploy_service" },
      status: "completed",
    });
    decided.calledTool("deploy_service", {
      count: 1,
      input: { service: "ledger-api" },
      status: "rejected",
    });
    t.calledTool(EXECUTE_TOOL, {
      count: 1,
      output: {
        calls: { completed: 1, rejected: 1 },
        result: [{ deployed: "billing-api", tool: "deploy_service" }, "not deployed"],
      },
    });
    decided.messageIncludes(
      'PROGRAM-RESULT [{"deployed":"billing-api","tool":"deploy_service"},"not deployed"]',
    );
  },
});
