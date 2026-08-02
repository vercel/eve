import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";

const mockMode = process.env.EVE_E2E_MODEL === "mock";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineAgent({
        description: "Return the dynamic-subagent availability marker.",
        model: mockMode
          ? "eve-mock/dynamic-subagent"
          : e2eSubagentConfig({ mock: "DYNAMIC_SUBAGENT_ENABLED" }).model,
      }),
  },
});
