import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Add a support tag to a customer record.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string(), tag: z.string() }),
  async execute({ customer, tag }) {
    return { customer, tag, tagged: true };
  },
});
