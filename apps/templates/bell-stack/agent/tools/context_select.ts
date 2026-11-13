import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { selectBrowserContext } from "../lib/browser-runtime";

export default defineTool({
  description:
    "Select a saved Browserbase Context for this task before the browser starts. Use context_list first when the Context ID is not known.",
  inputSchema: z.object({
    contextId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  }),
  async execute({ contextId }, ctx) {
    return selectBrowserContext(ctx.session.id, contextId);
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
