import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { respond } from "../../lib/mock-responder.js";

export default defineAgent({
  description: "Runs commands in an independent sandbox opened with deny-all networking.",
  ...e2eSubagentConfig({ mock: respond }),
});
