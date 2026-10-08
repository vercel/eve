import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Deploy the release.",
  inputSchema: z.object({}),
  async execute() {
    return { deployed: true };
  },
});
