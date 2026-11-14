import { z } from "zod";

import type { JsonValue } from "#lib/json";
import { isObject, isString } from "#lib/values";

/**
 * Functions a read-only query must never call.
 *
 * @remarks `set_config` can switch the session role mid-query. The `*_to_xml` family, `ts_stat`, the SQL form of `ts_rewrite`, `dblink`, and the contrib functions `crosstab`, `connectby`, and `xpath_table` run SQL text, which can be assembled at runtime so it never appears in the plan. Together they could read data under another granted role. `ts_rewrite` is blocked in every form because a plan doesn't show which overload was chosen. This list can't cover user-defined functions that run dynamic SQL, so separate logins per role, or revoking `set_config` from `PUBLIC`, are the complete fix. Session-level advisory locks survive the rollback and would stay held on the pooled connection, `pg_sleep` holds a connection without planner cost, and the backend signalling functions reach other sessions. Names are matched in EXPLAIN VERBOSE output, where Postgres has already resolved quoting and escapes and schema-qualifies functions outside the search path, such as `public.crosstab(`.
 */
const FORBIDDEN_CALL =
  /\b(?<name>set_config|query_to_xml(?:_and_xmlschema)?|query_to_xmlschema|cursor_to_xml(?:schema)?|(?:table|schema|database)_to_xml\w*|ts_stat|ts_rewrite|crosstab\d*|connectby|xpath_table|dblink\w*|pg_(?:try_)?advisory\w*|pg_sleep\w*|pg_(?:cancel|terminate)_backend)\s*\(/iu;

/* The parts of an EXPLAIN (FORMAT JSON) result the cost gate reads. */
const explainSchema = z
  .array(
    z.object({
      Plan: z.object({
        "Plan Rows": z.number().default(0),
        "Total Cost": z.number(),
      }),
    })
  )
  .min(1);

/** Planner estimate for a query. */
export interface PlanEstimate {
  readonly planRows: number;
  readonly totalCost: number;
}

/* A final semicolon followed only by whitespace, line comments, or block comments. Each line comment runs to its line end, and the match starts at the semicolon rather than at leading whitespace, so it never backtracks across a long run of spaces. */
const TRAILING_TERMINATOR =
  /;\s*(?:(?:--[^\n]*(?=\n|$)|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)\s*)*$/u;

/**
 * Trims a query and removes a final semicolon, along with any comments after it, so it can be wrapped.
 *
 * @param sql - Model-authored query text.
 * @returns The query without surrounding whitespace or a final semicolon.
 * @remarks Only trailing text is removed. Text that only looks like a terminator inside a string literal leaves the literal unterminated, and Postgres rejects the wrapped query. Nested block comments aren't recognized, so they stay and the query fails.
 */
export const normalizeSql = (sql: string): string =>
  sql.trim().replace(TRAILING_TERMINATOR, "").trimEnd();

/**
 * Wraps a query so Postgres only accepts a row-returning query and caps its rows.
 *
 * @param sql - Model-authored query text.
 * @param limit - Validated row cap, normally the configured maximum plus one to detect truncation.
 * @returns `SELECT * FROM (<sql>) AS eve_q LIMIT <limit>`.
 * @remarks The subquery position rejects writes, utility statements, and data-modifying CTEs.
 */
export const wrapQuery = (sql: string, limit: number): string =>
  `SELECT * FROM (\n${normalizeSql(sql)}\n) AS eve_q LIMIT ${Math.trunc(limit)}`;

/**
 * Finds a forbidden function call anywhere in an EXPLAIN (VERBOSE, FORMAT JSON) plan.
 *
 * @param plan - Parsed `QUERY PLAN` value.
 * @returns The lowercase function name, or null when the plan calls none.
 */
export const findForbiddenCall = (plan: JsonValue): string | null => {
  if (isString(plan)) {
    return FORBIDDEN_CALL.exec(plan)?.groups?.name?.toLowerCase() ?? null;
  }
  let children: JsonValue[] = [];
  if (Array.isArray(plan)) {
    children = plan;
  } else if (isObject(plan)) {
    children = Object.values(plan);
  }
  for (const child of children) {
    const found = findForbiddenCall(child);
    if (found) {
      return found;
    }
  }
  return null;
};

/**
 * Lists the tables and views a plan reads, from EXPLAIN (VERBOSE, FORMAT JSON) output.
 *
 * @param plan - Parsed `QUERY PLAN` value.
 * @returns Distinct `schema.relation` names in the order the plan first reads them.
 */
export const findRelations = (plan: JsonValue): string[] => {
  const found = new Set<string>();
  const visit = (node: JsonValue) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    if (!isObject(node)) {
      return;
    }
    const relation = node["Relation Name"];
    const schema = node.Schema;
    if (isString(relation)) {
      found.add(isString(schema) ? `${schema}.${relation}` : relation);
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(plan);
  return [...found];
};

/**
 * Reads the planner's cost and row estimates from an EXPLAIN (FORMAT JSON) result.
 *
 * @param plan - Parsed `QUERY PLAN` value: an array holding one `{ Plan }` object.
 * @returns Total planner cost and estimated output rows.
 * @throws {@link Error} When the value isn't an EXPLAIN JSON plan.
 */
export const planSummary = (plan: JsonValue): PlanEstimate => {
  const parsed = explainSchema.safeParse(plan);
  if (!parsed.success) {
    throw new Error("Postgres returned an unexpected EXPLAIN result.");
  }
  const [{ Plan: root }] = parsed.data;
  return { planRows: root["Plan Rows"], totalCost: root["Total Cost"] };
};
