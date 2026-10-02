import { defineDynamic } from "#dynamic/definition.js";
import { resolveConnectionTools } from "#execution/tools/connection-tools.js";

/** Provides `connection_search` and `connection_execute` while the agent has connections. */
export const connectionTools = defineDynamic({
  events: {
    "step.started": resolveConnectionTools,
  },
});

export default connectionTools;
