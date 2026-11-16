import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAnalystRole } from "#lib/analyst/access";
import { analystConfig } from "#lib/analyst/config";
import {
  describeTables,
  listTables,
  qualifyTableNames,
} from "#lib/analyst/postgres";

/** Model-facing describe_schema input. */
export const describeSchemaInputSchema = z.strictObject({
  tables: z
    .array(z.string().trim().min(1).max(200))
    .max(10)
    .optional()
    .describe(
      "Up to 10 table names, bare or schema-qualified (e.g., 'subscriptions' or 'analytics.subscriptions'). Omit to list every visible table."
    ),
});

/**
 * Lists or describes the warehouse tables the asking person's role can read.
 *
 * @remarks Without names it returns a compact overview with planner row estimates, so large schemas stay cheap; with names it returns columns, comments, and keys.
 */
export default defineTool({
  description:
    "Explore the analytics warehouse as the asking person's database role. Without arguments, list every visible table and view with its approximate row count and description. With table names, return their columns (type, nullability, and description), primary keys, and foreign keys. Read column descriptions carefully: they explain units, exclusions, and traps.",
  async execute({ tables }, ctx) {
    const role = requireAnalystRole(ctx.session);
    const { ANALYST_SCHEMAS: schemas, ANALYST_TIMEZONE: timezone } =
      analystConfig();
    if (!tables?.length) {
      const overview = await listTables(role);
      return {
        schemas,
        timezone,
        ...overview,
        ...(overview.tables.length === 0 && {
          note: `No visible tables in ${schemas.join(", ")}. The database role may lack grants, or ANALYST_SCHEMAS may name the wrong schemas.`,
        }),
      };
    }
    const details = await describeTables(role, tables);
    const found = new Set(details.map((table) => table.name));
    // Normalize each name the same way describeTables does, so quoted names match.
    const missing = tables.filter(
      (name) =>
        !qualifyTableNames([name], schemas).some((candidate) =>
          found.has(candidate)
        )
    );
    return {
      tables: details,
      ...(missing.length > 0 && {
        note: `No visible table named ${missing.join(", ")}. Call describe_schema without arguments to list tables.`,
      }),
    };
  },
  inputSchema: describeSchemaInputSchema,
});
