import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { respond } from "../../lib/mock-responder.js";

export default defineAgent({
  description: "Runs commands in a provider-owned sandbox shared by name across child sessions.",
  ...e2eSubagentConfig({ mock: respond }),
});
