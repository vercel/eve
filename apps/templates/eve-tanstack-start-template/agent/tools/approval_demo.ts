import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description:
    "Demonstrates human approval. Call it when the person asks to see an approval, describing an action you could take. Every call waits for their approval, and nothing actually runs, so tell them it was a demo.",
  inputSchema: z.object({
    action: z.string().describe("The action to approve, in a few words."),
  }),
  approval: always(),
  execute(input) {
    return { action: input.action, demo: true };
  },
});
