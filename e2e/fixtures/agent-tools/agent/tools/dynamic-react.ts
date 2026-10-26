import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

// The dynamic twin of `react_to_note` for `evals/static-tools/ends-turn-function.eval.ts`:
// its `endsTurn` function replays from a durable descriptor.
export default defineDynamic({
  events: {
    "session.started": () => ({
      dynamic_react_to_note: defineTool({
        description:
          "Smoke-test fixture: reacts to a team note with an emoji. Only call when the user explicitly asks to use `dynamic_react_to_note`. When the reaction posts, your turn ends; when it doesn't, tell the user.",
        inputSchema: z.object({
          emoji: z.string().min(1).describe("The emoji name, such as tada."),
        }),
        async execute({ emoji }) {
          return { emoji, posted: emoji === "tada" };
        },
        endsTurn: (output) => output.posted,
      }),
    }),
  },
});
