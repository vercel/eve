import { z as z3 } from "zod/v3";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Look up the current network policy for the active sandbox.",
  inputSchema: z3.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return { networkPolicy: sandbox.getNetworkPolicy() };
  },
});
