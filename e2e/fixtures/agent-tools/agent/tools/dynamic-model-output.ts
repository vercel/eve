import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

const RED_SQUARE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYElEQVR4nO3PwQkAIBDAMAX3H/lwCB9BaCZo96y/HR3wqgGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQHtAgK6AfwYG1VIAAAAAElFTkSuQmCC";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        check_model_output: defineTool({
          description:
            "Returns a raw result with full metadata. The model sees a projected image via toModelOutput. " +
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
              type: "content" as const,
              value: [
                {
                  type: "text" as const,
                  text: `Value: ${output.value}. Inspect the attached image and report its dominant color.`,
                },
                {
                  type: "file" as const,
                  data: { type: "data" as const, data: RED_SQUARE_BASE64 },
                  filename: "red-square.png",
                  mediaType: "image/png",
                },
              ],
            };
          },
        }),
      };
    },
  },
});
