import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Software-factory triage reviewer. Give this agent a completed triage report to produce a separate review summary before reproduction planning.",
  ...e2eSubagentConfig(),
  reasoning: "high",
});
