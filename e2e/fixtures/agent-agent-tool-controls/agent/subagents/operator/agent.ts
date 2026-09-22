import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Execute operational changes to systems and deployments.",
  ...e2eSubagentConfig({ mock: "AUTO-ROUTER-OPERATOR" }),
  tool: false,
});
