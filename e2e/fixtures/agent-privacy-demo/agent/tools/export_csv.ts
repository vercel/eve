import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Export records to a CSV file shared with a link.",
  inputSchema: z.object({ records: z.string() }),
  tags: ["effect:export"],
  async execute() {
    return { ok: true };
  },
});
