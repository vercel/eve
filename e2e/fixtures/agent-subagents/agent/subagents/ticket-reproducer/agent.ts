import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Software-factory reproduction planner. Give this agent completed triage and review results to produce a concrete reproduction artifact.",
  ...e2eSubagentConfig(),
  reasoning: "high",
});
