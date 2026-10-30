import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

/** The side effect whose ordering the evals check: it must follow the review it depends on. */
export default defineTool({
  description: "Publish a release summary to the team's announcements channel.",
  inputSchema: z.object({ summary: z.string().describe("The exact summary text to publish.") }),
  approval: never(),
  async execute({ summary }) {
    return { published: true, summary };
  },
});
