import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const toolPath = "agent/tools/query_tickets.ts";

// The data ships with the agent, so the tool never needs the network.
beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("query_tickets should not need the network.");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("answers questions from the sample data", { timeout: 60_000 }, async () => {
  const names = await query("SELECT name FROM customers ORDER BY id");
  for (const name of ["Umbrella", "Soylent", "Vandelay"]) {
    expect(JSON.stringify(names)).toContain(name);
  }

  const slowest = await query(
    "SELECT c.name, SUM(t.minutes_to_resolve) AS total FROM tickets t JOIN customers c ON c.id = t.customer_id GROUP BY c.name ORDER BY total DESC LIMIT 1",
  );
  expect(JSON.stringify(slowest)).toContain("Umbrella");
  expect(JSON.stringify(slowest)).toContain("345");
  expect(JSON.stringify(slowest)).not.toContain("Vandelay");
});

test("accepts WITH queries", { timeout: 60_000 }, async () => {
  const output = await query(
    "WITH high AS (SELECT * FROM tickets WHERE priority = 'high') SELECT count(*) AS n FROM high",
  );
  expect(JSON.stringify(output)).toMatch(/\b2\b/);
});

test("returns at most 200 rows", { timeout: 60_000 }, async () => {
  // 4^5 = 1024 rows, without a recursive CTE a tool may refuse to bound work.
  const output = await query(
    "SELECT a.id FROM tickets a, tickets b, tickets c, tickets d, tickets e",
  );
  const rows = largestArray(output);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(200);
});

test("refuses statements that change data", { timeout: 60_000 }, async () => {
  const tool = await load(toolPath);
  for (const sql of [
    "DELETE FROM tickets",
    "update tickets set priority = 'low'",
    "INSERT INTO customers VALUES (23, 'Initrode', 'pro')",
    "DROP TABLE tickets",
  ]) {
    const input = await parseInput(tool, sql);
    // A schema that rejects the statement refuses it before the tool runs.
    if (input === undefined) continue;
    let refused = false;
    try {
      const output = await tool.execute(input, toolContext());
      refused =
        /error|not allowed|read.?only|refus|reject|only (?:a )?(?:single )?select|forbidden|denied|invalid|unsupported/i.test(
          JSON.stringify(output) ?? "",
        );
    } catch {
      refused = true;
    }
    expect(refused, sql).toBe(true);
  }
  // A trailing write after a SELECT may be refused or never run; either way, it changes nothing.
  const smuggled = await parseInput(tool, "SELECT 1; DELETE FROM tickets");
  if (smuggled !== undefined) {
    await Promise.resolve()
      .then(() => tool.execute(smuggled, toolContext()))
      .catch(() => undefined);
  }
  expect(JSON.stringify(await query("SELECT count(*) AS n FROM tickets"))).toMatch(/\b4\b/);
  expect(JSON.stringify(await query("SELECT count(*) AS n FROM customers"))).toMatch(/\b3\b/);
});

async function query(sql: string): Promise<unknown> {
  const tool = await load(toolPath);
  const input = await parseInput(tool, sql);
  if (input === undefined)
    throw new Error(`The query_tickets schema rejected ${JSON.stringify(sql)}.`);
  return tool.execute(input, toolContext());
}

function toolContext() {
  return {
    session: { id: "session-1" },
    callId: "call-1",
    abortSignal: new AbortController().signal,
  };
}

/** The longest array anywhere in a value: the rows, whatever the output's shape. */
function largestArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return [value, ...value.map(largestArray)].reduce((a, b) => (b.length > a.length ? b : a));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.values(value)
    .map(largestArray)
    .reduce((a, b) => (b.length > a.length ? b : a), []);
}

/**
 * Validates input the way eve does for any accepted schema: Standard Schema
 * (Zod and others), or a plain JSON Schema object, which eve does not validate here.
 * The prompt names the field `sql`; `query` is accepted too.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function parseInput(tool: any, sql: string): Promise<unknown> {
  for (const input of [{ sql }, { query: sql }]) {
    const standard = tool.inputSchema?.["~standard"];
    if (typeof standard?.validate === "function") {
      const result = await standard.validate(input);
      if (!result.issues) return result.value;
      continue;
    }
    if (typeof tool.inputSchema?.safeParse === "function") {
      const result = tool.inputSchema.safeParse(input);
      if (result.success) return result.data;
      continue;
    }
    return input;
  }
  return undefined;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}
