import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { createBrowserContext, runCancelableBrowserWork } from "../lib/browser-runtime";

export default defineTool({
  description:
    "Create and select a named Browserbase Context for this task. If this task already has an automatic draft Context, promote that same Context without copying browser data.",
  inputSchema: z.object({
    name: z.string().trim().min(1).max(80),
  }),
  async execute({ name }, ctx) {
    return runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () =>
      createBrowserContext(ctx.session.id, name, ctx.abortSignal),
    );
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
