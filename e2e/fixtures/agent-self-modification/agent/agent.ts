import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig(),
  reasoning:
    (process.env.EVE_E2E_REASONING as "low" | "medium" | "high" | "xhigh" | undefined) ?? "high",
});
