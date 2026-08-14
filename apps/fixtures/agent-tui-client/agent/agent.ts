import { defineAgent } from "eve";

import { chatgpt } from "eve/models/openai";
export default defineAgent({
  model: chatgpt("gpt-5.6-sol"),
  reasoning: "xhigh",
  modelOptions: { providerOptions: { gateway: { serviceTier: "priority" } } },
});
