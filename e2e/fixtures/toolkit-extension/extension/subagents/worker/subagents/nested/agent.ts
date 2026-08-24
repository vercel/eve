import { defineAgent } from "eve";

export default defineAgent({
  description: "Nested toolkit worker used to verify recursive extension provenance.",
  model: "openai/gpt-5.6-sol",
});
