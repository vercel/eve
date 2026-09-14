import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Software-factory backlog reviewer. Give this agent a synthetic ticket batch to produce an independent review summary before reproduction planning.",
  ...e2eSubagentConfig(),
  reasoning: "high",
});
