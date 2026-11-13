import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireModelAccess } from "../lib/access.ts";
import { getModel } from "../lib/models.ts";

export default defineTool({
  description:
    "Read a dbt model's column types, descriptions, compiled SQL, lineage, metric definitions, joins, and caveats before answering or querying it.",
  inputSchema: z.object({ model: z.string().min(1).max(100) }),
  execute({ model }, ctx) {
    requireModelAccess(ctx.session.auth.current);
    return getModel(model);
  },
});
