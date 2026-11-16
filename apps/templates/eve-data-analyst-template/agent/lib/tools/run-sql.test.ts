import { beforeEach, describe, expect, it, vi } from "vitest";

import { postgres } from "../analyst/postgres";
import { queriesForTurn } from "../analyst/query-log";
import type { JsonValue } from "../json";
import { explainResult, fakePostgres } from "../testing/postgres";
import {
  isCallable,
  slackAuth,
  slackBotAuth,
  toolContext,
} from "../testing/session";
import { installTestState, testState } from "../testing/state";
import tool, { runSqlInputSchema, runSqlOutputSchema } from "./run-sql";

const { approval, execute } = tool;
if (!isCallable(execute)) {
  throw new Error("Expected an executable run_sql tool.");
}

const run = async (sql: string, current = slackAuth()) => {
  const result = await execute(
    { purpose: "Test", sql },
    toolContext({ current, toolName: "run_sql" })
  );
  if (Symbol.asyncIterator in result) {
    throw new Error("Expected a single result.");
  }
  return runSqlOutputSchema.parse(result);
};

const install = (rows: JsonValue[][]) => {
  const fake = fakePostgres((query) => {
    if (query.text.startsWith("EXPLAIN")) {
      return explainResult(1);
    }
    return query.text.startsWith("SELECT * FROM")
      ? { fields: [{ dataTypeID: 23, name: "n" }], rows }
      : {};
  });
  vi.spyOn(postgres, "connect").mockImplementation(fake.connect);
  return fake;
};

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
});

describe("run_sql", () => {
  it("restricts who can answer its approvals", () => {
    expect(approval).toMatchObject({
      request: expect.any(Function),
      response: expect.any(Function),
    });
  });

  it("runs as the caller's mapped role", async () => {
    vi.stubEnv(
      "ANALYST_ROLE_MAP",
      JSON.stringify({ "slack:T123:U123": "analyst_finance" })
    );
    const { queries } = install([[1]]);
    await expect(run("SELECT 1 AS n")).resolves.toMatchObject({ rows: [[1]] });
    expect(queries[0]?.text).toContain("SET LOCAL ROLE analyst_finance;");
  });

  it("records the query it ran for the turn's SQL attachment", async () => {
    install([[1]]);
    await run("SELECT 1 AS n");
    expect(queriesForTurn("turn-1")).toMatchObject([
      { purpose: "Test", sql: "SELECT 1 AS n", tables: [] },
    ]);
  });

  it("refuses callers without access before connecting", async () => {
    const { connect } = install([]);
    await expect(run("SELECT 1", slackBotAuth())).rejects.toThrow("Bots");
    expect(connect).not.toHaveBeenCalled();
  });

  it("tells the model to aggregate when rows were truncated", async () => {
    vi.stubEnv("ANALYST_MAX_ROWS", "10");
    install(Array.from({ length: 11 }, (_, index) => [index]));
    await expect(run("SELECT n FROM t")).resolves.toMatchObject({
      note: expect.stringContaining("Aggregate"),
      rowCount: 10,
      truncated: true,
    });
  });

  it.each([
    [{ purpose: "", sql: "SELECT 1" }],
    [{ purpose: "x".repeat(201), sql: "SELECT 1" }],
    [{ purpose: "Test", sql: "" }],
    [{ purpose: "Test", sql: "x".repeat(20_001) }],
    [{ extra: true, purpose: "Test", sql: "SELECT 1" }],
  ])("rejects invalid input %#", (input) => {
    expect(runSqlInputSchema.safeParse(input).success).toBe(false);
  });
});
