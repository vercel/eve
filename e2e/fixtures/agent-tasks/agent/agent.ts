import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

/**
 * Real-model release gate for task behavior: every eval here is tagged
 * `real-model`, because it checks how a live model plans around tasks.
 */
export default defineAgent({
  ...e2eAgentConfig(),
  description: "Coordinate reports, research, and release notes for Alice's team.",
});
