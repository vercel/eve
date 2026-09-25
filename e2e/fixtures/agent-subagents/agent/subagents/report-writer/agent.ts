import { defineAgent } from "eve";
import { choice } from "eve/models";

/**
 * Offers two Gateway models. The first is the default; callers may pick the
 * other through the `model` field of the `report-writer` tool.
 */
export default defineAgent({
  description: "Writes a short status report. Pass `model` to pick which model writes it.",
  model: choice({
    "openai/gpt-5.4-mini": "Short, routine reports.",
    "openai/gpt-5.4": "Reports that need careful reasoning.",
  }),
});
