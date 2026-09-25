import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Internal specialist hidden by its agent definition.",
  ...e2eSubagentConfig({ mock: "TOOL-FALSE-SUBAGENT-OK" }),
  tool: false,
});
