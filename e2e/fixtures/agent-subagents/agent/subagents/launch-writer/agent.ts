import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Drafts product launch announcements for the product team. It gathers the launch notes first, so a draft takes a minute or so.",
  ...e2eSubagentConfig(),
});
