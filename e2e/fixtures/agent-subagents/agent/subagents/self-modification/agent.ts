import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Delegate requests to change the eve agent, add reusable actions, or install and connect named capabilities. This acceptance-only child does not modify source or call tools.",
  model: e2eSubagentConfig().model,
});
