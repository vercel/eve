import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { respond } from "./lib/mock-responder.js";

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
  toolOutput: {
    maxInlineBytes: 64 * 1024,
    overflow: "sandbox",
  },
});
