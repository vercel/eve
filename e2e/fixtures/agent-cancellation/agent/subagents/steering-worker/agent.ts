import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Carries out an assignment while preserving its memo across corrections.",
  ...e2eSubagentConfig(),
});
