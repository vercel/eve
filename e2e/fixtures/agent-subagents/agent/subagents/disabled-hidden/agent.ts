import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Internal specialist hidden by a same-named disabled tool.",
  ...e2eSubagentConfig({ mock: "DISABLED-SUBAGENT-OK" }),
});
