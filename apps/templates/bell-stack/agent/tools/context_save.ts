import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { runCancelableBrowserWork, saveBrowserContext } from "../lib/browser-runtime";

export default defineTool({
  description:
    "Finish and save the current browser identity as a reusable Browserbase Context. This closes the browser and waits for Browserbase synchronization. If the task began as a fresh browser, provide a name and Bell will create a Context and preserve the current cookies before it closes. Never claim that a Context is saved until this tool returns status saved.",
  inputSchema: z.object({
    name: z.string().trim().min(1).max(80).optional(),
  }),
  async execute({ name }, ctx) {
    return runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () =>
      saveBrowserContext(ctx.session.id, name, ctx.abortSignal),
    );
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
