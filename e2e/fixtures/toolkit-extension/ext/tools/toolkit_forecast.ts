import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { stamp } from "../lib/brand.js";

// A dynamic capability authored inside an extension: the resolver registers a
// tool at session start, and it composes and runs like any other extension
// contribution once mounted. The token is built from the shared `ext/lib/brand`
// helper, so this proves ext/lib modules bundle into an extension's tools.
export default defineDynamic({
  events: {
    "session.started": async () => ({
      toolkit_forecast: defineTool({
        description:
          "Return the toolkit forecast token. Call when asked to run the toolkit forecast.",
        inputSchema: z.object({}),
        async execute() {
          return { token: stamp("forecast-ok-9F4Q") };
        },
      }),
    }),
  },
});
