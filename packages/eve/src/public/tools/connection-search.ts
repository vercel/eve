import { resolveConnectionSearchDynamicTools } from "#execution/tools/connection-search.js";
import { defineDynamic } from "#public/definitions/tool.js";

/** Canonical dynamic source for connection tool discovery. */
export const connectionSearch = defineDynamic({
  events: {
    "step.started": resolveConnectionSearchDynamicTools,
  },
});

export default connectionSearch;
