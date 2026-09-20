import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { respond } from "./mock-responder.js";

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
