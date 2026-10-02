import { defineTool } from "eve/tools";
import { z } from "zod";

import { environment } from "../sandbox.js";

export default defineTool({
  description: "Verifies that the configured environment exposes mutable network policy.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    await sandbox.setNetworkPolicy("deny-all");
    const result = await sandbox.run({
      command: "curl -sS --max-time 5 -o /dev/null https://example.com",
    });
    return {
      blocked: result.exitCode !== 0,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  },
});
