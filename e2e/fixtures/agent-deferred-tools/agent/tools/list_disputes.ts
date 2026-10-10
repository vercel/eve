import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "List open card disputes for a customer.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string() }),
  async execute({ customer }) {
    return { customer, disputes: ["DSP-17"] };
  },
});
