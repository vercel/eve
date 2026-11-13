import { defineAgent } from "eve";

export default defineAgent({
  // Spoken replies wait on the model, so a fast one keeps the conversation moving.
  model: "anthropic/claude-haiku-5.5",
});
