import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Export the general ledger for a month as CSV.",
  deferred: true,
  inputSchema: z.strictObject({ month: z.string() }),
  async execute({ month }) {
    return { month, rows: 318 };
  },
});
