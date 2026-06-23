import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Trivial downstream executable tool. Used by the client-resolved regression to
 * continue the turn AFTER a parked `ask_question` resumes — exercising the
 * reconstructed provider history (a duplicate result for the parked call would
 * reject that follow-up model call).
 */
export default defineTool({
  description:
    "Record a short note. Call this once, after the user answers a question, with their answer as `text`.",
  inputSchema: z.object({
    text: z.string().describe("The text to record."),
  }),
  async execute(input) {
    return { recorded: input.text };
  },
});
