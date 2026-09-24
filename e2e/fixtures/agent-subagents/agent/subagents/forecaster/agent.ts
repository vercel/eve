import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Reports tomorrow's forecast for one city. Ask it about one city per call; a lookup takes about 15 seconds.",
  ...e2eSubagentConfig(),
});
