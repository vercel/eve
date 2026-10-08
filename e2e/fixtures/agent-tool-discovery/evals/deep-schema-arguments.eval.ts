import { SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

import { INVOICE_DRAFT_ID, INVOICE_DRAFT_TOOL, PILOT_DISCOUNT } from "../agent/lib/invoice-draft";

/**
 * Bounds recovery by model steps rather than attempts: a call rejected by
 * input validation emits no `actions.requested` event, so attempts are not
 * countable from the stream. Budget: up to two searches, the first attempt
 * plus two corrections, and the reply.
 */
const MAX_MODEL_STEPS = 6;

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
    turn.eventsSatisfy(`${INVOICE_DRAFT_TOOL} runs with the pilot discount reason code`, (events) =>
      events.some(
        (event) =>
          event.type === "action.result" &&
          event.data.status === "completed" &&
          "toolName" in event.data.result &&
          event.data.result.toolName === INVOICE_DRAFT_TOOL &&
          (event.data.result.output as { reasonCode?: unknown } | undefined)?.reasonCode ===
            PILOT_DISCOUNT,
      ),
    );
    turn.eventsSatisfy(
      `the turn takes at most ${MAX_MODEL_STEPS} model steps`,
      (events) =>
        events.filter((event) => event.type === "step.completed").length <= MAX_MODEL_STEPS,
    );
    t.messageIncludes(INVOICE_DRAFT_ID);
  },
});
