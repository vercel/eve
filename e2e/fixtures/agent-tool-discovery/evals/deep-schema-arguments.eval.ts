import { SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { INVOICE_DRAFT_ID, INVOICE_DRAFT_TOOL } from "../agent/lib/invoice-draft";
import { calledTools } from "./tool-use";

/** Bounds recovery: the first attempt plus a couple of corrections from validation issues. */
const MAX_ATTEMPTS = 3;

/**
 * A deferred tool whose required field sits past the advertised signature's
 * depth limit, so it renders as `unknown`. The model has to build valid
 * arguments anyway, recovering from eve__execute's validation issues within a
 * bounded number of attempts.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A deferred tool with a schema deeper than its signature runs with valid arguments after bounded recovery.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice in finance needs a draft invoice for customer cus_204118, in US dollars:",
        "3 units of SKU-A7Q2 at $49.00 each.",
        "It skips the standard approval threshold because of the pilot discount we agreed on.",
        "Create the draft and tell her its draft id.",
      ].join(" "),
    );

    turn.expectOk();
    t.toolOrder([SEARCH_TOOL, INVOICE_DRAFT_TOOL]);
    t.calledTool(INVOICE_DRAFT_TOOL, { status: "completed" });
    turn.eventsSatisfy(
      `${INVOICE_DRAFT_TOOL} is attempted at most ${MAX_ATTEMPTS} times`,
      (events) =>
        calledTools(events).filter((name) => name === INVOICE_DRAFT_TOOL).length <= MAX_ATTEMPTS,
    );
    t.messageIncludes(INVOICE_DRAFT_ID);
  },
});
