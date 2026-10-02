import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.E0_MODEL ?? "openai/gpt-5.6-terra",
});
