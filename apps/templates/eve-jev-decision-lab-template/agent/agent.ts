import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  description: "Coordinate work that needs the root agent's complete set of capabilities.",
  model: auto({
    options: {
      "openai/gpt-5.6-luna":
        "Routine status updates, concise summaries, and straightforward questions.",
      "anthropic/claude-sonnet-5":
        "Investigations, planning, and requests that need careful synthesis.",
      "google/gemini-3.5-flash":
        "Requests involving images or files where fast multimodal analysis helps.",
    },
  }),
});
