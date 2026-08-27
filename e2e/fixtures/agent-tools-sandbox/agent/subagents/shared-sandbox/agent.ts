import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { respond } from "../../lib/mock-responder.js";

export default defineAgent({
  description: "Runs sandbox commands in the root agent's shared workspace.",
  ...e2eSubagentConfig({ mock: respond }),
});
