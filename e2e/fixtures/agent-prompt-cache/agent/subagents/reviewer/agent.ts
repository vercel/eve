import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eSubagentConfig(),
  description:
    "Review one purchasing sheet. The review_sheet tool has the stored sheets; the assignment only needs a sheet number and review question.",
  reasoning: "low",
});
