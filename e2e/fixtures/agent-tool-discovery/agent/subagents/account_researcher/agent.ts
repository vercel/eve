import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

/** A deferred agent: the root reaches it only through eve__search and eve__tool. */
export default defineAgent({
  ...e2eSubagentConfig(),
  description: "Research a customer account's history and summarize it for a meeting.",
  tool: "deferred",
});
