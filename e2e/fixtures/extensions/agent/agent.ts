import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { respond } from "./mock-responder.js";

if (process.env.EVE_EVALUATION === "1" && process.env.EVE_E2E_SETUP_READY !== "1") {
  throw new Error("Eval setup environment must be available before the agent loads.");
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
