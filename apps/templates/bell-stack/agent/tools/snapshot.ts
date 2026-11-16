import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { runBrowserOperation, runCancelableBrowserWork } from "../lib/browser-runtime";

export default defineTool({
  description:
    "Read the current page as a compact accessibility tree. The result marks access blocks. When pageStatus is blocked, continue on a different source. Bracketed target IDs are valid only until the page changes.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () =>
      runBrowserOperation(ctx.session.id, (browser) => browser.snapshot()),
    );
  },
  toModelOutput(output) {
    return toolOutput.json(output.result);
  },
});
