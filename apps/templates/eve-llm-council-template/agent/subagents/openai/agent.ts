import { defineAgent } from "eve";

export default defineAgent({
  description: "Independently answer the user's prompt with OpenAI GPT-5.6 Sol.",
  model: "openai/gpt-5.6-sol",
});
