import { runTakeoverTool, takeoverInputSchema, takeoverToolDescription } from "@eve/takeover/core";
import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension";
import { defaultSessionName } from "../lib/shared.js";
import { agentBrowserTakeoverSource } from "../lib/takeover";

const takeover = defineTool({
  description: takeoverToolDescription("browser"),
  inputSchema: takeoverInputSchema,
  async execute({ task }, ctx) {
    const config = extension.config;
    const source = agentBrowserTakeoverSource({
      binary: config.binary,
      session: config.session ?? defaultSessionName(config.sessionPrefix, "default"),
    });
    return await runTakeoverTool(config.takeover, ctx, source, task);
  },
});

/** Present only when the extension is mounted with a `takeover` configuration. */
export default defineDynamic(() => (extension.config.takeover ? takeover : null));
