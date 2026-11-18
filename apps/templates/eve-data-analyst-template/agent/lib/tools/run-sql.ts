import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAnalystRole } from "#lib/analyst/access";
import {
  requestRunSqlApproval,
  respondToRunSqlApproval,
} from "#lib/analyst/approval";
import { runReadOnlySql } from "#lib/analyst/postgres";
import { recordQuery } from "#lib/analyst/query-log";

/** Model-facing run_sql input. */
export const runSqlInputSchema = z.strictObject({
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One line on what this query answers, such as 'MRR at the end of September 2026'. Shown on the approval card."
    ),
  sql: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "One read-only Postgres SELECT (CTEs allowed). Aggregate in SQL; results are capped."
    ),
});

const cellSchema = z.json();

/** Bounded query result returned to the model. */
export const runSqlOutputSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  durationMs: z.number(),
  note: z.string().optional(),
  rowCount: z.number(),
  rows: z.array(z.array(cellSchema)),
  tables: z.array(z.string()),
  timezone: z.string(),
  truncated: z.boolean(),
  truncatedReason: z.enum(["output-size", "row-limit"]).nullable(),
});

/**
 * Runs one read-only query as the asking person's Postgres role.
 *
 * @remarks The approval policy plans the query first; execute re-checks access and the forbidden-function scan inside its own transaction as defense in depth.
 */
export default defineTool({
  // Inline object: eve compiles the approval property from source and treats a bare identifier as a policy function.
  approval: {
    request: requestRunSqlApproval,
    response: respondToRunSqlApproval,
  },
  description:
    "Run one read-only Postgres SELECT against the analytics warehouse as the asking person's database role. Returns typed columns and a capped set of rows; numeric and bigint values are strings, and dates and timestamps are text in the reporting time zone. Call describe_schema first if you are unsure of table or column names, and load the metric-definitions skill before computing a business metric. Expensive queries pause for the asker's approval.",
  async execute({ purpose, sql }, ctx) {
    const result = await runReadOnlySql(sql, requireAnalystRole(ctx.session));
    // Slack replies attach the exact queries that ran, so the model never has to repeat its SQL.
    recordQuery(ctx.session.turn.id, {
      purpose,
      ranAt: new Date().toISOString(),
      sql,
      tables: result.tables,
    });
    return result.truncated
      ? {
          ...result,
          note:
            result.truncatedReason === "row-limit"
              ? "More rows matched than were returned. Aggregate or filter in SQL instead of reading raw rows."
              : "The result was too large to return in full. Select fewer or narrower columns, or aggregate in SQL.",
        }
      : result;
  },
  inputSchema: runSqlInputSchema,
  outputSchema: runSqlOutputSchema,
});
