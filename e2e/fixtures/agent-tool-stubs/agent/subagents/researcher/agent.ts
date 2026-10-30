import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Research specialist. Call it only when Alice asks for the researcher, passing her question as the message.",
  ...e2eSubagentConfig(),
});
