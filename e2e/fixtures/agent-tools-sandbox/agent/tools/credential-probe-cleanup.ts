import { defineTool } from "eve/tools";
import { z } from "zod";

import { CREDENTIAL_PROBE_CLEANUP_PATH } from "../credential-probe.js";

export default defineTool({
  description:
    "Vercel-only E2E fixture: read the completed post-step credential cleanup probe. Only call when explicitly asked to use `credential-probe-cleanup`.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (typeof process.env.VERCEL_REGION !== "string") {
      return { mode: "local", supported: false } as const;
    }

    const sandbox = await ctx.getSandbox();
    const result = await sandbox.readTextFile({ path: CREDENTIAL_PROBE_CLEANUP_PATH });
    return {
      blockedAfterStep: result?.trim() === "blocked",
      mode: "vercel",
      result: result?.trim() ?? null,
      supported: true,
    } as const;
  },
});
