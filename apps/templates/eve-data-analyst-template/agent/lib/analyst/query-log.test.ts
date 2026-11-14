import { beforeEach, describe, expect, it } from "vitest";

import { installTestState, testState } from "../testing/state";
import { queriesForTurn, recordQuery, transferQueries } from "./query-log";

const query = (sql: string) => ({
  purpose: sql,
  ranAt: "2026-10-10T09:14:00.000Z",
  sql,
  tables: [],
});

beforeEach(() => {
  installTestState();
  testState.reset();
});

describe(recordQuery, () => {
  it("keeps the three most recent queries of the current turn", () => {
    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 3", "SELECT 4"]) {
      recordQuery("turn-1", query(sql));
    }
    expect(queriesForTurn("turn-1").map((entry) => entry.sql)).toStrictEqual([
      "SELECT 2",
      "SELECT 3",
      "SELECT 4",
    ]);
  });

  it("starts over for a new turn", () => {
    recordQuery("turn-1", query("SELECT 1"));
    recordQuery("turn-2", query("SELECT 2"));
    expect(queriesForTurn("turn-1")).toStrictEqual([]);
    expect(queriesForTurn("turn-2").map((entry) => entry.sql)).toStrictEqual([
      "SELECT 2",
    ]);
  });
});

describe(transferQueries, () => {
  it("moves queries to the resuming turn only from the matching turn", () => {
    recordQuery("turn-1", query("SELECT 1"));
    transferQueries("other", "turn-2");
    expect(queriesForTurn("turn-2")).toStrictEqual([]);
    transferQueries("turn-1", "turn-2");
    expect(queriesForTurn("turn-2")).toHaveLength(1);
  });
});
