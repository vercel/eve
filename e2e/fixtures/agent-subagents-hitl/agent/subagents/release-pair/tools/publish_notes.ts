import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Publish the release notes.",
  inputSchema: z.object({}),
  async execute() {
    return { published: true };
  },
});
