import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_STAGING_SCHEMA,
  inspectDemoSchema,
  loadDemoData,
  replacementBlocker,
} from "./load";
import type { SeedClient } from "./load";

const DEMO_TABLE_NAMES = [
  "plans",
  "customers",
  "subscriptions",
  "invoices",
  "payments",
  "refunds",
  "web_sessions",
  "signups",
];

/* The swap drops only the seed's own tables, then the schema with the default RESTRICT. */
const DROP_TABLES = `DROP TABLE IF EXISTS ${[...DEMO_TABLE_NAMES, "_eve_demo_seed"].map((table) => `analytics.${table}`).join(", ")}`;
const DROP_SCHEMA = "DROP SCHEMA IF EXISTS analytics";
const DROP_CASCADE = "DROP SCHEMA IF EXISTS analytics CASCADE";

const pause = vi.fn(() => Promise.resolve());

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

/* Records each statement; `respond` may throw to simulate a Postgres error. */
const fakeClient = (
  respond: (text: string) => readonly unknown[] = () => []
) => {
  const queries: RecordedQuery[] = [];
  const client: SeedClient = {
    query: (text, values) => {
      queries.push({ text, values });
      try {
        return Promise.resolve({ rows: respond(text) });
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  return { client, queries };
};

const lockTimeout = () =>
  Object.assign(new Error("canceling statement due to lock timeout"), {
    code: "55P03",
  });

const dependentObjects = () =>
  Object.assign(
    new Error(
      "cannot drop schema analytics because other objects depend on it"
    ),
    {
      code: "2BP01",
      detail:
        "table analytics.user_notes depends on schema analytics\nview public.report depends on table analytics.plans",
    }
  );

/* Throws a lock timeout for the first `failures` drops of the live schema. */
const failingDrops = (
  failures: number,
  error: () => Error = lockTimeout,
  statement = DROP_TABLES
) => {
  let drops = 0;
  return (text: string) => {
    if (text === statement) {
      drops += 1;
      if (drops <= failures) {
        throw error();
      }
    }
    return [];
  };
};

const indexOf = (queries: readonly RecordedQuery[], prefix: string) =>
  queries.findIndex((query) => query.text.startsWith(prefix));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe(loadDemoData, () => {
  it("builds the data in the staging schema and swaps it in at the end", async () => {
    const { client, queries } = fakeClient();
    await loadDemoData(client, "analytics", ["analyst_readonly"], { pause });
    const texts = queries.map((query) => query.text);
    const order = [
      "BEGIN",
      "SET LOCAL statement_timeout",
      "SELECT pg_advisory_xact_lock",
      `CREATE SCHEMA ${DEMO_STAGING_SCHEMA}`,
      `INSERT INTO ${DEMO_STAGING_SCHEMA}.plans`,
      `INSERT INTO ${DEMO_STAGING_SCHEMA}._eve_demo_seed`,
      `GRANT USAGE ON SCHEMA ${DEMO_STAGING_SCHEMA} TO analyst_readonly`,
      `ANALYZE ${DEMO_STAGING_SCHEMA}.plans`,
      "SET LOCAL lock_timeout = '5s'",
      "SAVEPOINT swap",
      DROP_TABLES,
      DROP_SCHEMA,
      `ALTER SCHEMA ${DEMO_STAGING_SCHEMA} RENAME TO analytics`,
      "RELEASE SAVEPOINT swap",
      "COMMIT",
    ].map((prefix) => indexOf(queries, prefix));
    expect(order).not.toContain(-1);
    expect(order).toStrictEqual(order.toSorted((a, b) => a - b));
    expect(texts.at(-1)).toBe("COMMIT");
    expect(texts).not.toContain("ROLLBACK");
    expect(texts).not.toContain(DROP_CASCADE);
  });

  it("drops the schema with CASCADE only when forced", async () => {
    const { client, queries } = fakeClient();
    await loadDemoData(client, "analytics", [], { force: true, pause });
    const texts = queries.map((query) => query.text);
    expect(texts).toContain(DROP_CASCADE);
    expect(texts).not.toContain(DROP_TABLES);
  });

  it("refuses the swap when objects were added to the schema or depend on it", async () => {
    const { client, queries } = fakeClient(
      failingDrops(1, dependentObjects, DROP_SCHEMA)
    );
    await expect(
      loadDemoData(client, "analytics", [], { pause })
    ).rejects.toThrow(
      'Objects were added to "analytics", or now depend on it, so the demo data wasn\'t replaced (table analytics.user_notes depends on schema analytics; view public.report depends on table analytics.plans). Run `pnpm db:seed --force` to replace it anyway, which drops them.'
    );
    const texts = queries.map((query) => query.text);
    expect(texts.filter((text) => text === DROP_SCHEMA)).toHaveLength(1);
    expect(texts.slice(-2)).toStrictEqual([
      "ROLLBACK TO SAVEPOINT swap",
      "ROLLBACK",
    ]);
    expect(pause).not.toHaveBeenCalled();
  });

  it("leaves the live schema alone until the swap", async () => {
    const { client, queries } = fakeClient();
    await loadDemoData(client, "analytics", ["analyst_readonly"], { pause });
    const drop = indexOf(queries, DROP_TABLES);
    const early = queries
      .slice(0, drop)
      .filter((query) => /\banalytics\b/u.test(query.text));
    expect(early).toStrictEqual([]);
  });

  it("analyzes every demo table before the swap", async () => {
    const { client, queries } = fakeClient();
    await loadDemoData(client, "analytics", [], { pause });
    const analyze = queries.find((query) => query.text.startsWith("ANALYZE"));
    const tables = DEMO_TABLE_NAMES.map(
      (table) => `${DEMO_STAGING_SCHEMA}.${table}`
    );
    expect(analyze?.text).toBe(`ANALYZE ${tables.join(", ")}`);
  });

  it("binds plan rows column by column", async () => {
    const { client, queries } = fakeClient();
    const { data } = await loadDemoData(client, "analytics", [], { pause });
    const insert = queries.find((query) =>
      query.text.startsWith(`INSERT INTO ${DEMO_STAGING_SCHEMA}.plans`)
    );
    expect(insert?.text).toBe(
      `INSERT INTO ${DEMO_STAGING_SCHEMA}.plans (plan_id, name, monthly_price_cents, annual_price_cents) SELECT * FROM unnest($1::text[], $2::text[], $3::integer[], $4::integer[])`
    );
    expect(insert?.values).toStrictEqual([
      data.plans.map((plan) => plan.plan_id),
      data.plans.map((plan) => plan.name),
      data.plans.map((plan) => plan.monthly_price_cents),
      data.plans.map((plan) => plan.annual_price_cents),
    ]);
  });

  it("retries the swap from the savepoint after a lock timeout", async () => {
    const { client, queries } = fakeClient(failingDrops(1));
    await loadDemoData(client, "analytics", [], { pause });
    const texts = queries.map((query) => query.text);
    const swap = texts.slice(texts.indexOf("SET LOCAL lock_timeout = '5s'"));
    expect(swap).toStrictEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SAVEPOINT swap",
      DROP_TABLES,
      "ROLLBACK TO SAVEPOINT swap",
      "SAVEPOINT swap",
      DROP_TABLES,
      DROP_SCHEMA,
      `ALTER SCHEMA ${DEMO_STAGING_SCHEMA} RENAME TO analytics`,
      "RELEASE SAVEPOINT swap",
      "COMMIT",
    ]);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("rolls back after the last lock timeout", async () => {
    const { client, queries } = fakeClient(failingDrops(3));
    await expect(
      loadDemoData(client, "analytics", [], { pause })
    ).rejects.toMatchObject({
      code: "55P03",
    });
    const texts = queries.map((query) => query.text);
    expect(
      texts.filter((text) => text === "ROLLBACK TO SAVEPOINT swap")
    ).toHaveLength(3);
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
  });

  it("rolls back at once on an error other than a lock timeout", async () => {
    const { client, queries } = fakeClient(
      failingDrops(1, () => new Error("permission denied for schema analytics"))
    );
    await expect(
      loadDemoData(client, "analytics", [], { pause })
    ).rejects.toThrow("permission denied");
    const texts = queries.map((query) => query.text);
    expect(texts.filter((text) => text === DROP_TABLES)).toHaveLength(1);
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(pause).not.toHaveBeenCalled();
  });

  it("refuses when a schema with the staging name already exists", async () => {
    const { client, queries } = fakeClient((text) =>
      text.startsWith("SELECT 1 FROM pg_namespace") ? [{ "?column?": 1 }] : []
    );
    await expect(
      loadDemoData(client, "analytics", [], { pause })
    ).rejects.toThrow(`Schema "${DEMO_STAGING_SCHEMA}" already exists`);
    const texts = queries.map((query) => query.text);
    expect(texts.some((text) => text.startsWith("CREATE SCHEMA"))).toBe(false);
    expect(texts.at(-1)).toBe("ROLLBACK");
  });

  it("refuses to load into the staging schema itself", async () => {
    const { client, queries } = fakeClient();
    await expect(
      loadDemoData(client, DEMO_STAGING_SCHEMA, [], { pause })
    ).rejects.toThrow("reserved");
    expect(queries).toStrictEqual([]);
  });
});

describe(inspectDemoSchema, () => {
  it("looks up the current role in pg_roles, so names that need quoting work", async () => {
    const { client, queries } = fakeClient();
    await expect(inspectDemoSchema(client, "analytics")).resolves.toBeNull();
    const [query] = queries;
    expect(query?.text).toContain(
      "(SELECT oid FROM pg_roles WHERE rolname = current_user)"
    );
    expect(query?.text).not.toMatch(/current_user::regrole/u);
  });
});

describe(replacementBlocker, () => {
  it("names other objects in the schema without calling them tables", () => {
    expect(
      replacementBlocker("analytics", {
        anchorAt: null,
        dependents: [],
        grantees: [],
        marked: true,
        others: ["important_report"],
      })
    ).toBe(
      `Schema "analytics" also contains objects db:seed didn't create (important_report).`
    );
  });
});
