import { defineAgent } from "eve";

export default defineAgent({
  description: "Independently answer the user's prompt with SpaceXAI Grok 4.7.",
  model: "spacexai/grok-4.7",
});
