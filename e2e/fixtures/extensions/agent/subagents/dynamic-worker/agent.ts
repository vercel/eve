import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineAgent({
        ...e2eSubagentConfig(),
        description: "Dynamic inspection worker selected when a session starts.",
      }),
  },
});
