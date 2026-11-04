import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Export records to a CSV file shared with a link.",
  inputSchema: z.object({ records: z.string() }),
  tags: ["effect:irreversible", "sink:public"],
  async execute() {
    return { ok: true };
  },
});
