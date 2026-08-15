import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Waits until its delegated turn is cancelled.",
  ...e2eSubagentConfig(),
});
