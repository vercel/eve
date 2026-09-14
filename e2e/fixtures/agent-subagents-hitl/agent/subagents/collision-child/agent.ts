import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Return the marker from the request without calling any tools.",
  ...e2eSubagentConfig(),
});
