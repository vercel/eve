import { defineDynamic, defineTool } from "eve/tools";

import { referenceOf } from "../lib/catalog";
import { INVOICE_DRAFT_ID, INVOICE_DRAFT_SCHEMA, INVOICE_DRAFT_TOOL } from "../lib/invoice-draft";

/** The deep-schema deferred tool; it only runs once eve__execute's validation accepts the input. */
export default defineDynamic({
  events: {
    "session.started": () => ({
      [INVOICE_DRAFT_TOOL]: defineTool({
        deferred: true,
        description:
          "Create a draft invoice for a customer, with line items and finance approval routing.",
        inputSchema: INVOICE_DRAFT_SCHEMA,
        execute: (input: {
          routing: {
            approvals: {
              finance: { policy: { thresholds: { override: { reasonCode: string } } } };
            };
          };
        }) => ({
          reference: referenceOf(INVOICE_DRAFT_TOOL),
          draftId: INVOICE_DRAFT_ID,
          reasonCode: input.routing.approvals.finance.policy.thresholds.override.reasonCode,
        }),
      }),
    }),
  },
});
