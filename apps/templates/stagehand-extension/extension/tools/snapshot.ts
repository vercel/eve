import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStagehandResources } from "../lib/session.js";

export default defineTool({
  description: "Return the accessibility snapshot for the active Stagehand page.",
  inputSchema: z.object({
    includeIframes: z.boolean().default(true),
  }),
  async execute({ includeIframes }) {
    const { browser } = await getStagehandResources();
    const page = (await browser.context.activePage()) ?? (await browser.context.newPage());
    const snapshot = await page.snapshot({ includeIframes });
    return snapshot.formattedTree;
  },
});
