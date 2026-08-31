import { resolveConnectionSearchDynamicTools } from "#execution/tools/connection-search.js";
import { defineDynamic } from "#dynamic/definition.js";

/** Canonical definition for dynamic connection tool discovery. */
export const connectionSearch = defineDynamic({
  events: {
    "step.started": resolveConnectionSearchDynamicTools,
  },
});

export default connectionSearch;
