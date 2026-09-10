import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eSubagentConfig(),
  description: "Look up one warehouse with probe and report its inventory item.",
});
