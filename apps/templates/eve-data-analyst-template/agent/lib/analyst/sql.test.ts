import { describe, expect, it } from "vitest";

import type { JsonValue } from "../json";
import {
  findForbiddenCall,
  findRelations,
  normalizeSql,
  planSummary,
  wrapQuery,
} from "./sql";

const plan = (node: { readonly [field: string]: JsonValue }): JsonValue => [
  { Plan: node },
];

describe(normalizeSql, () => {
  it.each([
    ["  SELECT 1;  ", "SELECT 1"],
    ["SELECT 1 ;\n", "SELECT 1"],
    ["SELECT ';'", "SELECT ';'"],
    ["SELECT 1; -- total", "SELECT 1"],
    ["SELECT 1;\n-- a\n-- b\n", "SELECT 1"],
    ["SELECT 1; /* total */", "SELECT 1"],
    ["SELECT 1; /* a ** b */ -- c\n/* d */", "SELECT 1"],
    ["SELECT 1 ;  ", "SELECT 1"],
    ["SELECT 1 -- note", "SELECT 1 -- note"],
    ["SELECT 1; SELECT 2", "SELECT 1; SELECT 2"],
    ["SELECT 1; /* a /* nested */ b */", "SELECT 1; /* a /* nested */ b */"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeSql(input)).toBe(expected);
  });

  // run_sql accepts up to 20,000 characters; each input below would backtrack badly with a looser pattern.
  it.each([
    ["many line comments", `;${" --".repeat(6666)}\nx`],
    ["a semicolon before every line comment", `${";--x".repeat(4999)}\nx`],
    ["unclosed block comments", `${";/*x".repeat(4999)}x`],
    ["a long run of spaces", `;${" ".repeat(19_998)}x`],
    ["spaces before a late semicolon", `x${" ".repeat(19_997)};x`],
  ])("stays fast with %s", (_name, input) => {
    const started = performance.now();
    expect(normalizeSql(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe(wrapQuery, () => {
  it("wraps the query in a capped subquery", () => {
    expect(wrapQuery("WITH t AS (SELECT 1) SELECT * FROM t;", 501)).toBe(
      "SELECT * FROM (\nWITH t AS (SELECT 1) SELECT * FROM t\n) AS eve_q LIMIT 501"
    );
  });

  it("drops a semicolon before a trailing comment", () => {
    expect(wrapQuery("SELECT count(*) FROM signups; -- total", 501)).toBe(
      "SELECT * FROM (\nSELECT count(*) FROM signups\n) AS eve_q LIMIT 501"
    );
  });

  it("ends a trailing line comment before the closing parenthesis", () => {
    expect(wrapQuery("SELECT 1 -- note", 501)).toBe(
      "SELECT * FROM (\nSELECT 1 -- note\n) AS eve_q LIMIT 501"
    );
  });
});

describe(findForbiddenCall, () => {
  it.each([
    ["set_config('role'::text, 'analyst_finance'::text, true)", "set_config"],
    ["pg_catalog.set_config('role'::text, 'x'::text, true)", "set_config"],
    ["query_to_xml('select 1'::text, true, false, ''::text)", "query_to_xml"],
    [
      "QUERY_TO_XML_AND_XMLSCHEMA ('x'::text, true, false, ''::text)",
      "query_to_xml_and_xmlschema",
    ],
    ["table_to_xml('t'::regclass, true, false, ''::text)", "table_to_xml"],
    ["database_to_xmlschema(true, false, ''::text)", "database_to_xmlschema"],
    ["dblink_exec('x'::text)", "dblink_exec"],
    ["pg_advisory_lock('42'::bigint)", "pg_advisory_lock"],
    ["pg_try_advisory_lock_shared(1)", "pg_try_advisory_lock_shared"],
    ["pg_sleep_for('00:01:00'::interval)", "pg_sleep_for"],
    ["pg_terminate_backend(123)", "pg_terminate_backend"],
    ["ts_stat(concat('sel'::text, 'ect 1'::text))", "ts_stat"],
    ["pg_catalog.ts_stat('x'::text, 'ab'::text)", "ts_stat"],
    [
      "ts_rewrite('a'::tsquery, 'SELECT t, s FROM aliases'::text)",
      "ts_rewrite",
    ],
    ["ts_rewrite('a'::tsquery, 'a'::tsquery, 'b'::tsquery)", "ts_rewrite"],
    ["public.crosstab('x'::text)", "crosstab"],
    ["\"Contrib\".crosstab('x'::text, 'y'::text)", "crosstab"],
    ["crosstab3('x'::text)", "crosstab3"],
    ["connectby('t'::text, 'k'::text, 'p'::text, '1'::text, 0)", "connectby"],
    [
      "xpath_table('k'::text, 'd'::text, 't'::text, '/a'::text, 'true'::text)",
      "xpath_table",
    ],
  ])("finds %j", (expression, name) => {
    expect(
      findForbiddenCall(
        plan({ Output: ["1"], Plans: [{ Filter: expression }] })
      )
    ).toBe(name);
  });

  it.each([
    "current_setting('TimeZone'::text)",
    "my_set_config_audit.value",
    "xmlelement(name x, 'set_config')",
    "sum(amount_cents)",
    "ts_rank(v, q)",
    "to_tsvector('english'::regconfig, body)",
    "ts_headline('english'::regconfig, body, q)",
    "ts_stats_total(v)",
    "my_ts_stat_cache.value",
    "my_crosstab_view.total",
  ])("ignores %j", (expression) => {
    expect(findForbiddenCall(plan({ Output: [expression] }))).toBeNull();
  });

  it("finds calls in function scans", () => {
    expect(
      findForbiddenCall(
        plan({
          Plans: [
            {
              "Function Call": "ts_stat(concat('sel'::text, 'ect 1'::text))",
              "Node Type": "Function Scan",
            },
          ],
        })
      )
    ).toBe("ts_stat");
  });
});

describe(planSummary, () => {
  it("reads cost and rows", () => {
    expect(
      planSummary(plan({ "Plan Rows": 42, "Total Cost": 1234.5 }))
    ).toStrictEqual({ planRows: 42, totalCost: 1234.5 });
  });

  it.each([null, [], [{}], [{ Plan: { "Total Cost": "1" } }]])(
    "rejects %j",
    (value) => {
      expect(() => planSummary(value)).toThrow("unexpected EXPLAIN");
    }
  );
});

describe(findRelations, () => {
  it("lists each table and view the plan reads once, in order", () => {
    expect(
      findRelations(
        plan({
          Plans: [
            { "Relation Name": "subscriptions", Schema: "analytics" },
            { Plans: [{ "Relation Name": "customers", Schema: "analytics" }] },
            { "Relation Name": "subscriptions", Schema: "analytics" },
          ],
        })
      )
    ).toStrictEqual(["analytics.subscriptions", "analytics.customers"]);
  });

  it("returns nothing for plans without tables", () => {
    expect(findRelations(plan({ Output: ["1"] }))).toStrictEqual([]);
  });
});
