import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eSubagentConfig(),
  description:
    'Review one community-centre purchasing sheet. The assignment is its identifier, such as "Sheet 1". The stored sheet provides the notes and review question.',
  reasoning: "low",
});
