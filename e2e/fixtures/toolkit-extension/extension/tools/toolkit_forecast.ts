import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { stamp } from "../lib/brand";

// Dynamic capability authored inside an extension: the resolver registers a tool
// at session start that composes and runs once mounted.
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
