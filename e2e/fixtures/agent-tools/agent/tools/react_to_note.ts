import { defineTool } from "eve/tools";
import { z } from "zod";

// Covers `endsTurn` as a function of the execute output
// (`evals/static-tools/ends-turn-function.eval.ts`): a posted reaction ends the
// turn, and a reaction the team channel doesn't allow leaves the model to reply.
export default defineTool({
  description:
    "Smoke-test fixture: reacts to a team note with an emoji. Only call when the user explicitly asks to use `react_to_note`. When the reaction posts, your turn ends; when it doesn't, tell the user.",
  inputSchema: z.object({
    emoji: z.string().min(1).describe("The emoji name, such as tada."),
  }),
  async execute({ emoji }) {
    return { emoji, posted: emoji === "tada" };
  },
  endsTurn: (output) => output.posted,
});
