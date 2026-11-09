import { defineAgent } from "eve";

// Every voice request waits on this model, so prefer a fast one.
export default defineAgent({
  model: "anthropic/claude-haiku-5.5",
});
