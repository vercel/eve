import { defineDynamic, defineTool } from "eve/tools";

import { CATALOG_TOOLS, referenceOf } from "../lib/catalog";

/**
 * Every catalog tool, deferred, for the whole session. One resolver serves the
 * table so the evals and the agent agree on names and results; the model sees
 * the same deferred entries as authored files would give it.
 */
export default defineDynamic({
  resolve: () =>
    Object.fromEntries(
      CATALOG_TOOLS.map(({ description, inputs = {}, name, result }) => [
        name,
        defineTool({
          deferred: true,
          description,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(inputs).map(([input, about]) => [
                input,
                { type: "string", description: about },
              ]),
            ),
          },
          execute: () => ({ reference: referenceOf(name), ...result }),
        }),
      ]),
    ),
});
