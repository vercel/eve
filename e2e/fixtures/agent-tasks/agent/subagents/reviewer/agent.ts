import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Reviews a release summary and approves it or requests changes.",
  ...e2eSubagentConfig(),
});
