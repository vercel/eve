import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Collects Alice's release checklist sign-off with verification_gate and reports its sign-off code.",
  ...e2eSubagentConfig(),
});
