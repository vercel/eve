import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-luna",
  reasoning: "medium",
  modelOptions: { providerOptions: { gateway: { serviceTier: "priority" } } },
});
