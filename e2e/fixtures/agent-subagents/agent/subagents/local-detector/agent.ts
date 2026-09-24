import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Coordinates Alice's release checklist sign-off by handing it to verification-worker.",
  ...e2eSubagentConfig(),
});
