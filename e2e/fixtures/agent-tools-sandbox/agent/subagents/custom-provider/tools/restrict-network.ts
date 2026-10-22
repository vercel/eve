import { defineTool } from "eve/tools";
import { z } from "zod";

import { environment } from "../sandbox.js";

export default defineTool({
  description: "Asks the machine to allow only example.com, then to deny all network access.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    let allowList: string;
    try {
      await sandbox.setNetworkPolicy({ allow: ["example.com"] });
      allowList = "accepted";
    } catch (error) {
      allowList = error instanceof Error ? error.message : String(error);
    }
    await sandbox.setNetworkPolicy("deny-all");
    return { allowList, denyAll: "accepted" };
  },
});
