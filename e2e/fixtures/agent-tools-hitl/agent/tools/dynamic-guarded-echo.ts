import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export const DYNAMIC_GUARDED_ECHO_TOKEN = "dynamic-guarded-echo-ok-L8R6";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        dynamic_guarded_echo: defineTool({
          description:
            "Smoke-test fixture for replayed dynamic tool approval. Echoes the note input. Only call when the user explicitly asks for `dynamic_guarded_echo`.",
          inputSchema: z.object({
            note: z.string().optional(),
          }),
          approval: () => "user-approval",
          async execute(input) {
            return {
              echoed: input.note ?? null,
              token: DYNAMIC_GUARDED_ECHO_TOKEN,
            };
          },
        }),
      };
    },
  },
});
