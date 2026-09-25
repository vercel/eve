import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eSubagentConfig(),
  description:
    "Delegate requests to change the eve agent, add reusable actions, or install and connect named capabilities. " +
    "Treat questions about whether you can install, add, enable, or connect to a named product or service as requests to extend this eve agent and delegate immediately. The child handles installation scope and setup clarification. " +
    "This acceptance-only child does not modify source or call tools.",
});
