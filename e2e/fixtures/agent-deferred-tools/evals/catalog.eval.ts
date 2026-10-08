import { EXECUTE_TOOL, SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/** Deferred entries of each kind, none of which the listing may name. */
const DEFERRED = [
  "refund_invoice",
  "deploy_service",
  "research_report",
  "billing_specialist",
  "pdf-forms",
  "release_notes",
  "tenant-playbook",
  "ledger__us_west",
];

export default defineEval({
  description:
    "Deferred entries stay out of the tool list, which keeps eve__search and eve__execute, and one listing names their kinds, namespaces, and connections, but no entry.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-CATALOG");

    turn.expectOk();
    turn.usedNoTools();
    t.messageIncludes("DEFERRED-IN-TOOLS: none");
    t.messageIncludes(`CATALOG-TOOLS: ${SEARCH_TOOL}, ${EXECUTE_TOOL}`);
    t.messageIncludes("You have more tools, agents, and skills than are loaded here.");
    // The dynamic ledger tools share one namespace.
    t.messageIncludes(/^Namespaces, .*: ledger$/mu);
    t.messageIncludes("\n- petstore: Pet store inventory API.");
    t.check(
      turn.message ?? "",
      satisfies(
        (message: string) => DEFERRED.every((name) => !message.includes(name)),
        "the listing names no deferred entry",
      ),
    );
  },
});
