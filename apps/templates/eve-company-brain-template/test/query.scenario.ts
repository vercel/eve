import assert from "node:assert/strict";
import { test } from "node:test";
import { querySql } from "../agent/lib/query.ts";
import { getModel, listModels } from "../agent/lib/models.ts";

// The golden values come from the pinned Jaffle Shop seeds, built with data:build.
test("Jaffle Shop catalog and queries agree on grain, units, and historical dates", async () => {
  assert.deepEqual(
    listModels().models.map((model) => model.name),
    ["customers", "orders"],
  );
  assert.match(getModel("orders").meta.metrics.amount!, /AUD/);
  const customers = getModel("customers");
  assert.match(
    customers.columns.find((column) => column.name === "customer_lifetime_value")?.description ??
      "",
    /AUD/,
  );
  assert.ok("customer_lifetime_value" in customers.meta.metrics);
  assert.throws(() => getModel("raw_payments"), /Unknown model/);
  const result = await querySql(
    "SELECT COUNT(*) AS orders, SUM(amount) AS amount, MIN(order_date) AS first_date, MAX(order_date) AS last_date FROM main.orders",
  );
  assert.deepEqual(result.rows, [["99", 1672, "2018-01-01", "2018-04-09"]]);
  assert.equal(result.truncated, false);
  const customerTotals = await querySql(`
    SELECT COUNT(*), SUM(number_of_orders), SUM(customer_lifetime_value),
           COUNT(*) FILTER (WHERE number_of_orders IS NULL)
    FROM customers
  `);
  assert.deepEqual(customerTotals.rows, [["100", "99", 1672, "38"]]);
  const monthly = await querySql(`
    WITH customer_orders AS (
      SELECT o.order_date, o.amount
      FROM orders o JOIN customers c ON o.customer_id = c.customer_id
    ), months AS (
      SELECT date_trunc('month', order_date) AS month, SUM(amount) AS amount
      FROM customer_orders GROUP BY 1
    ) SELECT * FROM months ORDER BY month;
  `);
  assert.deepEqual(monthly.rows, [
    ["2018-01-01", 496],
    ["2018-02-01", 415],
    ["2018-03-01", 622],
    ["2018-04-01", 139],
  ]);
});

test("query execution rejects writes, unapproved relations, and external readers", async () => {
  for (const sql of [
    "DELETE FROM orders",
    "SELECT 1; SELECT 2",
    "SELECT 1; DROP TABLE orders",
    "SELECT * FROM raw_payments",
    "SELECT * FROM main.stg_orders",
    "SELECT * FROM information_schema.tables",
    "SELECT * FROM other.main.orders",
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM query_table('raw_payments')",
    "SELECT getenv('motherduck_token')",
    "SELECT current_setting('motherduck_token')",
    "SELECT * FROM (WITH raw_payments AS (SELECT * FROM orders) SELECT * FROM raw_payments) q UNION ALL SELECT * FROM raw_payments",
    "WITH RECURSIVE x(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM x) SELECT * FROM x",
  ]) {
    await assert.rejects(querySql(sql), /not allowed|Only relations|one SELECT/, sql);
  }
  const intact = await querySql("SELECT COUNT(*) FROM orders");
  assert.deepEqual(intact.rows, [["99"]]);
});

test("result rows and bytes are bounded and truncation is explicit", async () => {
  const detail = await querySql("SELECT a.order_id, b.order_id FROM orders a CROSS JOIN orders b");
  assert.equal(detail.rows.length, 200);
  assert.equal(detail.truncated, true);
  const text = "x".repeat(14_000);
  const wide = await querySql(
    `WITH text AS (SELECT '${text}' AS value) SELECT concat(value,value,value,value,value) AS value FROM text`,
  );
  assert.deepEqual(wide.rows, []);
  assert.equal(wide.truncated, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(wide.columns)) +
      Buffer.byteLength(JSON.stringify(wide.rows)) <=
      65_536,
  );
  await assert.rejects(querySql("x".repeat(16_385)), /16,384 bytes/);
});

test("cancellation interrupts work and releases the connection for subsequent queries", async () => {
  const controller = new AbortController();
  const promise = querySql(
    "SELECT SUM(a.amount * b.amount * c.amount * d.amount * e.amount) FROM orders a CROSS JOIN orders b CROSS JOIN orders c CROSS JOIN orders d CROSS JOIN orders e",
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(promise, /interrupted/);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual((await querySql("SELECT COUNT(*) FROM orders")).rows, [["99"]]);
});
