import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eSubagentConfig(),
  description: "Review one numbered purchasing sheet and return its result.",
  reasoning: "low",
});
