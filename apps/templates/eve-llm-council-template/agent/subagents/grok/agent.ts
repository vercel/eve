import { defineAgent } from "eve";

export default defineAgent({
  description: "Independently answer the user's prompt with xAI Grok 4.5.",
  model: "xai/grok-4.5",
});
