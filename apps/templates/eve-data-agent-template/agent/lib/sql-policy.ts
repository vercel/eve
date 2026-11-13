const allowedFunctions = new Set([
  "count",
  "count_star",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "stddev_samp",
  "round",
  "abs",
  "ceil",
  "floor",
  "greatest",
  "least",
  "nullif",
  "coalesce",
  "date_trunc",
  "date_part",
  "date_diff",
  "date_add",
  "strftime",
  "strptime",
  "year",
  "month",
  "day",
  "today",
  "now",
  "current_date",
  "lower",
  "upper",
  "length",
  "trim",
  "ltrim",
  "rtrim",
  "substring",
  "substr",
  "concat",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "+",
  "-",
  "*",
  "/",
  "%",
  "//",
  "~~",
  "!~~",
  "~~*",
  "!~~*",
  "||",
]);

const allowedTableReferences = new Set([
  "BASE_TABLE",
  "JOIN",
  "SUBQUERY",
  "EXPRESSION_LIST",
  "EMPTY",
]);

export class QueryError extends Error {}

export function validateSqlAst(ast: unknown, allowedRelations: ReadonlySet<string>): void {
  if (!ast || typeof ast !== "object") throw new QueryError("Could not parse SQL.");
  const parsed = ast as { error?: boolean; statements?: unknown[] };
  if (parsed.error || parsed.statements?.length !== 1) {
    throw new QueryError(
      "Use exactly one SELECT query, optionally with non-recursive CTEs. Writes and other statements are not allowed.",
    );
  }
  let nodes = 0;
  function visit(
    value: unknown,
    depth: number,
    ctes: ReadonlySet<string>,
    tableReference = false,
  ): void {
    if (++nodes > 10_000 || depth > 60)
      throw new QueryError("Simplify the query: it is too complex.");
    if (tableReference) {
      const type =
        value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
      if (typeof type !== "string" || !allowedTableReferences.has(type)) {
        throw new QueryError(
          "Unsupported table reference. Query documented models with SELECT; metadata commands and table functions are not allowed.",
        );
      }
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, ctes);
      return;
    }
    const node = value as Record<string, unknown>;
    let scope = ctes;
    if (node.cte_map && typeof node.cte_map === "object") {
      const entries = (node.cte_map as { map: { key: string; value: unknown }[] }).map;
      const localCtes = new Set(ctes);
      // A CTE may reference earlier CTEs, but must not leak into sibling subqueries.
      for (const entry of entries) {
        visit(entry.value, depth + 1, localCtes);
        localCtes.add(entry.key.toLowerCase());
      }
      scope = localCtes;
    }
    if (node.type === "BASE_TABLE") {
      const table = String(node.table_name).toLowerCase();
      const schema = String(node.schema_name ?? "").toLowerCase();
      const isModel = allowedRelations.has(`main.${table}`);
      const isCte = !schema && scope.has(table);
      const isMainSchema = !schema || schema === "main";
      if (node.catalog_name || !isMainSchema || (!isModel && !isCte)) {
        throw new QueryError(
          "Only relations returned by list_models are allowed. Do not query raw, staging, system, or other database tables.",
        );
      }
    }
    if (node.type === "RECURSIVE_CTE_NODE") {
      throw new QueryError(
        "Recursive queries are not allowed. Use a non-recursive CTE or query the documented models directly.",
      );
    }
    if (
      typeof node.function_name === "string" &&
      (!allowedFunctions.has(node.function_name.toLowerCase()) ||
        node.catalog ||
        node.schema ||
        node.export_state)
    ) {
      throw new QueryError(
        "Use built-in analytical functions only. File, URL, system, and custom functions are not allowed.",
      );
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "cte_map") continue;
      const childIsTableReference =
        key === "from_table" || (node.type === "JOIN" && (key === "left" || key === "right"));
      visit(child, depth + 1, scope, childIsTableReference);
    }
  }
  visit(parsed.statements[0], 0, new Set());
}
