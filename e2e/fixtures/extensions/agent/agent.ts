import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { respond } from "./mock-responder.js";

const configured = e2eAgentConfig({ mock: respond });
const dynamicModelResult =
  configured.modelContextWindowTokens === undefined
    ? { model: configured.model }
    : {
        model: configured.model,
        modelContextWindowTokens: configured.modelContextWindowTokens,
      };

export default defineAgent({
  experimental: {
    ...configured.experimental,
    tasks: true,
  },
  model: defineDynamic({
    events: {
      "step.started": () => dynamicModelResult,
    },
  }),
  reasoning: "high",
});
