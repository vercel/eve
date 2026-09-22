import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Complete Alice's nested verification after she releases the worker.",
  ...e2eSubagentConfig(),
});
