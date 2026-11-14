import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { runBrowserOperation, runCancelableBrowserWork } from "../lib/browser-runtime";

export default defineTool({
  description:
    "Capture the visible page when layout, images, or visual state are important. Bell's web chat shows the image in its browser preview.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () =>
      runBrowserOperation(ctx.session.id, (browser) => browser.screenshot(), true),
    );
  },
  toModelOutput(output) {
    if (!output.result.data) return toolOutput.json(output.result);
    return toolOutput.content([
      toolOutputPart.text(`Screenshot of ${output.result.url}`),
      toolOutputPart.file(output.result.data, { mediaType: output.result.mediaType }),
    ]);
  },
});
