import { resolveConnectionSearchTools } from "#execution/tools/connection-search.js";
import { defineDynamic } from "#public/definitions/tool.js";

export {
  CONNECTION_SEARCH_INPUT_SCHEMA,
  CONNECTION_SEARCH_OUTPUT_SCHEMA,
  CONNECTION_SEARCH_RESULT_ITEM_SCHEMA,
  type ConnectionSearchInput,
  type ConnectionSearchResultItem,
} from "#public/tools/connection-search-contract.js";

/** eve's canonical dynamic connection-search definition. */
export const connectionSearch = defineDynamic({
  events: {
    "step.started": resolveConnectionSearchTools,
  },
});
