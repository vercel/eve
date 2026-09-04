import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { respond } from "./lib/schema-replay-responder";

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
