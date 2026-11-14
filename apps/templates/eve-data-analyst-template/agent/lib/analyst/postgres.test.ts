import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../json";
import { explainResult, fakePostgres } from "../testing/postgres";
import type { FakeResult } from "../testing/postgres";
import type { AnalystQuery } from "./postgres";
import {
  describeTables,
  explainQuery,
  isWarehouseUnavailable,
  listTables,
  postgres,
  qualifyTableNames,
  runReadOnlySql,
  WarehouseUnavailableError,
} from "./postgres";

const SETUP = [
  "BEGIN TRANSACTION READ ONLY",
  "SET LOCAL statement_timeout = 20000",
  "SET LOCAL ROLE analyst_readonly",
  "SET LOCAL search_path = analytics",
  "SET LOCAL TIME ZONE 'UTC'",
];

const install = (respond?: (query: AnalystQuery) => FakeResult) => {
  const fake = fakePostgres(respond);
  vi.spyOn(postgres, "connect").mockImplementation(fake.connect);
  return fake;
};

const answering =
  (
    data: FakeResult,
    cost = 10,
    plan: { readonly [field: string]: JsonValue } = {}
  ) =>
  (query: AnalystQuery): FakeResult => {
    if (query.text.startsWith("EXPLAIN")) {
      return explainResult(cost, plan);
    }
    return query.text.startsWith("SELECT * FROM") ? data : {};
  };

beforeEach(() => {
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
});

describe(runReadOnlySql, () => {
  it("plans and runs the wrapped query in a rolled-back read-only transaction", async () => {
    const { client, queries } = install(
      answering({
        fields: [
          { dataTypeID: 25, name: "plan" },
          { dataTypeID: 1700, name: "mrr" },
        ],
        rows: [["pro", "1200.00"]],
      })
    );
    const result = await runReadOnlySql(
      "SELECT plan, sum(mrr) AS mrr FROM t GROUP BY 1;",
      "analyst_readonly"
    );
    const wrapped =
      "SELECT * FROM (\nSELECT plan, sum(mrr) AS mrr FROM t GROUP BY 1\n) AS eve_q LIMIT 501";
    expect(queries.map((query) => query.text)).toStrictEqual([
      SETUP.join(";\n"),
      `EXPLAIN (VERBOSE, FORMAT JSON) ${wrapped}`,
      wrapped,
      "ROLLBACK",
    ]);
    expect(queries[1]).toMatchObject({ queryMode: "extended" });
    expect(queries[2]).toMatchObject({
      queryMode: "extended",
      rowMode: "array",
      types: expect.objectContaining({ getTypeParser: expect.any(Function) }),
    });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(result).toMatchObject({
      columns: [
        { name: "plan", type: "text" },
        { name: "mrr", type: "numeric" },
      ],
      rowCount: 1,
      rows: [["pro", "1200.00"]],
      timezone: "UTC",
      truncated: false,
      truncatedReason: null,
    });
  });

  it("refuses a plan that calls a forbidden function before running it", async () => {
    const { client, queries } = install(
      answering({}, 10, {
        Output: ["set_config('role'::text, 'analyst_finance'::text, true)"],
      })
    );
    await expect(
      runReadOnlySql(
        "SELECT set_config('role', 'analyst_finance', true)",
        "analyst_readonly"
      )
    ).rejects.toThrow("Queries can't call set_config().");
    expect(
      queries.some((query) => query.text.startsWith("SELECT * FROM"))
    ).toBe(false);
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("hides connection details when it can't connect", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => null);
    vi.spyOn(postgres, "connect").mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND db.internal.example")
    );
    const failure = runReadOnlySql("SELECT 1", "analyst_readonly");
    await expect(failure).rejects.toThrow("couldn't connect to the database.");
    await expect(failure).rejects.toBeInstanceOf(WarehouseUnavailableError);
    await expect(failure).rejects.not.toThrow("db.internal.example");
  });

  it("reports a failed session setup as unavailable, then rolls back and releases", async () => {
    const { client, queries } = install((query) => {
      if (query.text.startsWith("BEGIN")) {
        throw Object.assign(
          new Error('permission denied to set role "analyst_readonly"'),
          { code: "42501" }
        );
      }
      return {};
    });
    const failure = runReadOnlySql("SELECT 1", "analyst_readonly");
    await expect(failure).rejects.toBeInstanceOf(WarehouseUnavailableError);
    await expect(failure).rejects.toThrow(
      "couldn't start a read-only session as your database role (permission denied to set role"
    );
    expect(queries.map((query) => query.text)).toStrictEqual([
      SETUP.join(";\n"),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("refuses a plan that calls ts_stat() before running it", async () => {
    const { queries } = install(
      answering({}, 10, {
        Plans: [
          {
            "Function Call": "ts_stat(concat('sel'::text, 'ect 1'::text))",
            "Node Type": "Function Scan",
          },
        ],
      })
    );
    await expect(
      runReadOnlySql(
        "SELECT * FROM ts_stat(concat('sel', 'ect 1'))",
        "analyst_readonly"
      )
    ).rejects.toThrow("Queries can't call ts_stat().");
    expect(
      queries.some((query) => query.text.startsWith("SELECT * FROM"))
    ).toBe(false);
  });

  it("rolls back and releases when the query fails", async () => {
    const { client, queries } = install((query) => {
      if (query.text.startsWith("EXPLAIN")) {
        throw new Error('column "nope" does not exist');
      }
      return {};
    });
    await expect(
      runReadOnlySql("SELECT nope", "analyst_readonly")
    ).rejects.toThrow("nope");
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("destroys the connection when rollback fails", async () => {
    const { client } = install((query) => {
      if (query.text === "ROLLBACK") {
        throw new Error("connection lost");
      }
      return answering({ fields: [], rows: [] })(query);
    });
    await runReadOnlySql("SELECT 1", "analyst_readonly");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("reports truncation when Postgres returns the extra row", async () => {
    vi.stubEnv("ANALYST_MAX_ROWS", "10");
    install(
      answering({
        fields: [{ dataTypeID: 23, name: "n" }],
        rows: Array.from({ length: 11 }, (_, index) => [index]),
      })
    );
    const result = await runReadOnlySql("SELECT n FROM t", "analyst_readonly");
    expect(result.rowCount).toBe(10);
    expect(result.truncatedReason).toBe("row-limit");
  });
});

const pgError = (code: string) =>
  Object.assign(new Error(`Postgres error ${code}`), { code });

describe(isWarehouseUnavailable, () => {
  it.each([
    ["08006", true],
    ["28P01", true],
    ["3D000", true],
    ["53300", true],
    ["57P01", true],
    ["57P03", true],
    ["58030", true],
    ["57014", false],
    ["42501", false],
    ["42P01", false],
    ["22012", false],
  ])("treats SQLSTATE %s as unavailable: %s", (code, expected) => {
    expect(isWarehouseUnavailable(pgError(code))).toBe(expected);
  });

  it.each([
    ["the analyst's own error", new WarehouseUnavailableError("down"), true],
    ["a plain error", new Error("Connection terminated unexpectedly"), false],
    [
      "a malformed code",
      Object.assign(new Error("x"), { code: "ECONNRESET" }),
      false,
    ],
    ["a string", "08006", false],
    ["null", null, false],
  ])("handles %s", (_name, error, expected) => {
    expect(isWarehouseUnavailable(error)).toBe(expected);
  });
});

describe(explainQuery, () => {
  it("returns cost, rows, and forbidden calls for the wrapped query", async () => {
    const { queries } = install(
      answering({}, 2_500_000, {
        Plans: [{ Filter: "query_to_xml('x'::text, true, false, ''::text)" }],
      })
    );
    await expect(
      explainQuery("SELECT 1", "analyst_finance")
    ).resolves.toStrictEqual({
      forbidden: "query_to_xml",
      planRows: 10,
      tables: [],
      totalCost: 2_500_000,
    });
    expect(queries[0]?.text).toContain("SET LOCAL ROLE analyst_finance;");
    expect(queries[1]?.text).toContain(
      "EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM (\nSELECT 1\n)"
    );
  });
});

describe(listTables, () => {
  it("lists visible relations with row estimates", async () => {
    const { queries } = install((query) =>
      query.text.includes("pg_class")
        ? {
            rows: [
              {
                approx_rows: "1200",
                comment: "Paying accounts.",
                kind: "table",
                name: "analytics.customers",
              },
              {
                approx_rows: null,
                comment: null,
                kind: "view",
                name: "analytics.mrr_daily",
              },
            ],
          }
        : {}
    );
    await expect(listTables("analyst_readonly")).resolves.toStrictEqual({
      tables: [
        {
          approxRows: 1200,
          comment: "Paying accounts.",
          kind: "table",
          name: "analytics.customers",
        },
        {
          approxRows: null,
          comment: null,
          kind: "view",
          name: "analytics.mrr_daily",
        },
      ],
      truncated: false,
    });
    expect(queries[1]?.values).toStrictEqual([["analytics"], 301]);
    expect(queries[1]?.text).toContain("has_schema_privilege(n.oid, 'USAGE')");
  });
});

describe(describeTables, () => {
  it("groups columns and keys per table", async () => {
    const { queries } = install((query) => {
      if (query.text.includes("pg_attribute")) {
        return {
          rows: [
            {
              column_comment: "Stable ID.",
              column_name: "customer_id",
              column_type: "bigint",
              name: "analytics.customers",
              not_null: true,
              table_comment: "Accounts.",
            },
            {
              column_comment: null,
              column_name: "country",
              column_type: "text",
              name: "analytics.customers",
              not_null: false,
              table_comment: "Accounts.",
            },
          ],
        };
      }
      if (query.text.includes("pg_constraint")) {
        return {
          rows: [
            {
              definition: "PRIMARY KEY (customer_id)",
              name: "analytics.customers",
            },
          ],
        };
      }
      return {};
    });
    await expect(
      describeTables("analyst_readonly", ["customers"])
    ).resolves.toStrictEqual([
      {
        columns: ["customer_id bigint not null -- Stable ID.", "country text"],
        comment: "Accounts.",
        keys: ["PRIMARY KEY (customer_id)"],
        name: "analytics.customers",
      },
    ]);
    const catalogQueries = queries.filter((query) =>
      /pg_attribute|pg_constraint/u.test(query.text)
    );
    expect(catalogQueries).toHaveLength(2);
    for (const query of catalogQueries) {
      expect(query.text).toContain("has_schema_privilege(n.oid, 'USAGE')");
    }
  });

  it("skips the database when no name is in an allowed schema", async () => {
    const { queries } = install();
    await expect(
      describeTables("analyst_readonly", ["billing.invoices"])
    ).resolves.toStrictEqual([]);
    expect(queries.some((query) => query.text.includes("pg_attribute"))).toBe(
      false
    );
  });
});

describe(qualifyTableNames, () => {
  it("expands bare names and keeps allowed qualified names", () => {
    expect(
      qualifyTableNames(
        [
          "Customers",
          '"analytics"."plans"',
          "billing.invoices",
          "web_sessions",
        ],
        ["analytics", "marketing"]
      )
    ).toStrictEqual([
      "analytics.customers",
      "marketing.customers",
      "analytics.plans",
      "analytics.web_sessions",
      "marketing.web_sessions",
    ]);
  });
});
