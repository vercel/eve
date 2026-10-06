import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Close a customer's billing account after a final invoice.",
  deferred: true,
  inputSchema: z.strictObject({ customer: z.string() }),
  async execute({ customer }) {
    return { closed: true, customer };
  },
});
