import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

// The voice app shows the approval on screen and reads it aloud. The user
// answers with a button or by saying an option; the voice model never answers.
export default defineTool({
  description: "Create a reminder for the user.",
  inputSchema: z.object({
    text: z.string().min(1).describe("What to remind the user about."),
    when: z.string().min(1).describe("When to send the reminder, in the user's words."),
  }),
  approval: always(),
  async execute({ text, when }) {
    return { id: crypto.randomUUID(), status: "scheduled (sample only)", text, when };
  },
});
