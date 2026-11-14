import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { runBrowserOperation, runCancelableBrowserWork } from "../lib/browser-runtime";
import { browserActionSchema } from "../lib/browser-schema";

export default defineTool({
  description:
    "Run a short batch of exact actions in the persistent Stagehand browser. Use CSS selectors or IDs from the latest snapshot. When a site blocks access, go to a different source in the same browser task.",
  inputSchema: z.object({
    actions: z.array(browserActionSchema).min(1).max(12),
  }),
  async execute({ actions }, ctx) {
    return runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () =>
      runBrowserOperation(ctx.session.id, (browser) => browser.run(actions)),
    );
  },
  toModelOutput(output) {
    return toolOutput.json(output.result);
  },
});
