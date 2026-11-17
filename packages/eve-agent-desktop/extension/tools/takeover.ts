import { runTakeoverTool, takeoverInputSchema, takeoverToolDescription } from "@eve/takeover/core";
import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension";
import { vncTakeoverSource } from "../lib/takeover";

const takeover = defineTool({
  description: takeoverToolDescription("desktop"),
  inputSchema: takeoverInputSchema,
  async execute({ task }, ctx) {
    const config = extension.config;
    const source = vncTakeoverSource({
      display: config.display,
      manageDesktop: config.manageDesktop,
    });
    return await runTakeoverTool(config.takeover, ctx, source, task);
  },
});

/** Present only when the extension is mounted with a `takeover` configuration. */
export default defineDynamic(() => (extension.config.takeover ? takeover : null));
