import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Researches product metrics, such as churn by region and quarter, in the team's research archive.",
  ...e2eSubagentConfig(),
});
