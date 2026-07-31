import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";

const conditionalMarker = defineAgent({
  ...e2eSubagentConfig({ mock: "DYNAMIC_SUBAGENT_ENABLED" }),
  description: "Return the dynamic-subagent availability marker.",
});

export default defineDynamic({
  fallback: conditionalMarker,
  events: {
    "session.started": () => conditionalMarker,
  },
});
