import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** A deferred tool that asks for approval on every call, so a batch of calls asks together. */
export default defineTool({
  description:
    "Send a payment follow-up note to one customer. A person reviews each note before it goes out.",
  deferred: true,
  approval: always(),
  inputSchema: z.strictObject({ customer: z.string(), note: z.string() }),
  outputSchema: z.strictObject({ customer: z.string(), sent: z.boolean() }),
  async execute({ customer }) {
    return { customer, sent: true };
  },
});
