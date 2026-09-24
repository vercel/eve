import { e2eAgentConfig, waitForTasks } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { respond } from "./lib/mock-responder.js";

export default defineAgent({
  // Subagent calls start detached tasks; the script reads their results.
  ...e2eAgentConfig({ mock: waitForTasks(respond) }),
  reasoning: "high",
});
