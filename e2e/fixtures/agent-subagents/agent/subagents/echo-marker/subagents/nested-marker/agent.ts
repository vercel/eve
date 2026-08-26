import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Nested direct-invocation marker agent.",
  ...e2eSubagentConfig(),
  reasoning: "high",
});
