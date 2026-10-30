import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireModelAccess } from "../lib/access.ts";
import { listModels } from "../lib/models.ts";

export default defineTool({
  description: "List the available dbt analytics models, their relations, and row grains.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    requireModelAccess(ctx.session.auth.current);
    return listModels();
  },
});
