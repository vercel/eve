import { defineAgent } from "eve";
import { e2eSubagentConfig } from "@eve-e2e/config";
import { mode } from "../../lib/arms";
export default defineAgent({
  ...e2eSubagentConfig(),
  tool: mode === "subagents",
  description: "Retrieve live facts about incidents, on-call, ownership and observability.",
});
