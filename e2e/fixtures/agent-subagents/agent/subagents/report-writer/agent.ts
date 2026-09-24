import { defineAgent } from "eve";

/**
 * Lists two Gateway models. The first is the default; callers may pick the
 * other through the `model` field of the `report-writer` tool.
 */
export default defineAgent({
  description: "Writes a short status report. Pass `model` to pick which listed model writes it.",
  model: ["openai/gpt-5.4-mini", "openai/gpt-5.4"],
});
