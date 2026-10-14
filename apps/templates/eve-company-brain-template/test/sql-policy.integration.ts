import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { limitSql, validateSqlAst } from "../agent/lib/sql-policy.ts";

let database: DuckDBInstance;
let connection: DuckDBConnection;
const allowedRelations = new Set(["main.orders"]);

before(async () => {
  database = await DuckDBInstance.create(":memory:");
  connection = await database.connect();
  await connection.run(`
    CREATE TABLE orders (id INTEGER, amount INTEGER);
    INSERT INTO orders VALUES (1, 10), (2, 20);
    CREATE TABLE raw_customers (id INTEGER, secret VARCHAR);
    INSERT INTO raw_customers VALUES (1, 'private');
  `);
});

after(() => {
  connection.closeSync();
  database.closeSync();
});

async function parseSql(sql: string) {
  const literal = `'${sql.replaceAll("'", "''")}'`;
  const result = await connection.runAndReadAll(`SELECT json_serialize_sql(${literal})`);
  return JSON.parse(String(result.getRowsJS()[0][0]));
}

async function execute(sql: string, maxRows = 10) {
  validateSqlAst(await parseSql(sql), allowedRelations);
  const result = await connection.runAndReadAll(limitSql(sql, maxRows));
  return result.getRowsJson();
}

test("metadata commands and unknown table references are rejected before execution", async () => {
  for (const sql of [
    "SHOW TABLES",
    "SHOW ALL TABLES",
    "DESCRIBE",
    "DESCRIBE raw_customers",
    "SELECT * FROM (SHOW ALL TABLES)",
    "WITH metadata AS (SELECT * FROM (SHOW ALL TABLES)) SELECT * FROM metadata",
    "SELECT orders.id FROM orders CROSS JOIN (SHOW ALL TABLES) metadata",
  ]) {
    await assert.rejects(execute(sql), /Unsupported table reference/, sql);
  }

  const ast = await parseSql("SELECT * FROM orders");
  ast.statements[0].node.from_table.type = "FUTURE_TABLE_REFERENCE";
  assert.throws(() => validateSqlAst(ast, allowedRelations), /Unsupported table reference/);
});

test("approved SELECT table-reference forms remain usable", async () => {
  for (const sql of [
    "SELECT amount FROM main.orders ORDER BY id",
    "SELECT a.amount FROM orders a JOIN orders b ON a.id = b.id ORDER BY a.id",
    "SELECT amount FROM (SELECT * FROM orders) o ORDER BY id",
    "SELECT * FROM (VALUES (10), (20)) v(amount)",
    "SELECT 10 UNION ALL SELECT 20",
    "WITH first AS (SELECT * FROM orders), second AS (SELECT * FROM first) SELECT amount FROM second ORDER BY id",
  ]) {
    assert.deepEqual(await execute(sql), [[10], [20]], sql);
  }
});

test("bounded queries preserve trailing SQL comments and the row cap", async () => {
  for (const sql of [
    "SELECT amount FROM orders ORDER BY id -- trailing comment",
    "SELECT amount FROM orders ORDER BY id -- trailing comment\n",
    "SELECT amount FROM orders WHERE 'text -- not a comment' = 'text -- not a comment' ORDER BY id -- trailing comment",
    "SELECT amount FROM orders ORDER BY id;",
  ]) {
    assert.deepEqual(await execute(sql, 1), [[10]], sql);
  }
});
