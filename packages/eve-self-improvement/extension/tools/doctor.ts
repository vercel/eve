import { defineTool } from "eve/tools";
import { z } from "zod";
import extension from "../extension.js";
import { owned } from "../lib/config.js";
import { checkReadiness } from "../lib/readiness.js";

/** Checks setup and observed provider execution for the authenticated configured owner. */
export default defineTool({
  description:
    "Verify self-improvement setup against real storage, Vercel Agent Runs and GitHub. Reports passed/failed/unavailable/pending separately; can exercise a real sandbox and authenticated production smoke. Configured owner only.",
  availableInSubagents: false,
  inputSchema: z.object({
    sandbox: z.boolean().default(false),
    production: z.boolean().default(false),
  }),
  async execute(input, ctx) {
    if (!owned(extension.config, ctx.session.auth.current))
      throw new Error("Only the configured authenticated owner can inspect setup");
    return { checks: await checkReadiness(extension.config, input) };
  },
});
