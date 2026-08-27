import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineDynamic, defineLocalSubagent } from "eve";

const mockMode = process.env.EVE_E2E_MODEL === "mock";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineLocalSubagent({
        background: false,
        description: "Return the dynamic-subagent availability marker.",
        model: mockMode
          ? "eve-mock/dynamic-subagent"
          : e2eSubagentConfig({ mock: "DYNAMIC_SUBAGENT_ENABLED" }).model,
        modelContextWindowTokens: 1_000_000,
      }),
  },
});
