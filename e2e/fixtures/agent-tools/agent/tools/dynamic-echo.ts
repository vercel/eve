import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export const DYNAMIC_ECHO_TOKEN = "dynamic-echo-ok-X7R2";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        echo_dynamic: defineTool({
          description:
            "Smoke-test fixture for dynamic tools: echoes the input with a token. " +
            "Only call when the user explicitly asks to use `echo_dynamic`.",
          inputSchema: z.object({
            message: z.string(),
          }),
          async execute(input) {
            return {
              echoed: input.message,
              token: DYNAMIC_ECHO_TOKEN,
            };
          },
        }),
      };
    },
  },
});
