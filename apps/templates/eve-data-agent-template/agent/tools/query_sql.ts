import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireModelAccess } from "../lib/access.ts";
import { querySql } from "../lib/query.ts";

export default defineTool({
  description:
    "Execute one read-only DuckDB SELECT against documented models. Non-recursive CTEs and joins are supported; table functions and external access are not. Returns at most 200 rows and 64 KiB of result data. Read model definitions first.",
  inputSchema: z.object({ sql: z.string().min(1).max(16_384) }),
  async execute({ sql }, ctx) {
    requireModelAccess(ctx.session.auth.current);
    return querySql(sql, ctx.abortSignal);
  },
});
