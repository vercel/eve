import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export const MODEL_OUTPUT_TOKEN = "projected-X9K3";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        check_model_output: defineTool({
          description:
            "Returns a raw result with full metadata. The model sees a projected summary via toModelOutput. " +
            "Only call when the user explicitly asks to check model output.",
          inputSchema: z.object({ value: z.string() }),
          async execute(input) {
            return {
              raw: true,
              value: input.value,
              secret: "internal-only-data",
            };
          },
          toModelOutput(output) {
            return {
              type: "json" as const,
              value: {
                projected: true,
                value: output.value,
                token: MODEL_OUTPUT_TOKEN,
              },
            };
          },
        }),
      };
    },
  },
});
