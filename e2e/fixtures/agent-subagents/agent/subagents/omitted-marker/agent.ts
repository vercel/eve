import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";

const omittedMarker = defineAgent({
  ...e2eSubagentConfig({ mock: "NIL_SUBAGENT_WAS_CALLED" }),
  description: "This subagent must be omitted from the model-visible toolset.",
});

export default defineDynamic({
  fallback: omittedMarker,
  events: {
    "session.started": () => null,
  },
});
