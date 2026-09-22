import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Coordinate Alice's verification using the declared verification-worker.",
  ...e2eSubagentConfig(),
});
