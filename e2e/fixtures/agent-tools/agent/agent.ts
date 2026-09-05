import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  experimental: {
    ...base.experimental,
    maxModelCallsPerWorkflowStep: 3,
  },
  reasoning: "high",
});
