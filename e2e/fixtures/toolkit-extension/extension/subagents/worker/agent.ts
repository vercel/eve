import { defineAgent } from "eve";

export default defineAgent({
  description: "Toolkit extension worker used to verify mounted subagent provenance.",
  model: "openai/gpt-5.6-sol",
});
