/**
 * Fake Postgres clients for unit tests that record every query in order.
 *
 * @packageDocumentation
 */
import { vi } from "vitest";

import type {
  AnalystClient,
  AnalystQuery,
  AnalystQueryResult,
} from "../analyst/postgres";
import type { JsonValue } from "../json";

/** Partial result returned for a recorded query. */
export interface FakeResult {
  readonly fields?: AnalystQueryResult["fields"];
  readonly rows?: readonly JsonValue[];
}

/**
 * Builds a fake client whose results come from `respond`.
 *
 * @param respond - Returns the result for a query, or throws to simulate a Postgres error. Defaults to empty results.
 * @returns The client, its recorded queries, and a `connect` replacement that resolves to the client.
 */
export const fakePostgres = (
  respond: (query: AnalystQuery) => FakeResult = () => ({})
) => {
  const queries: AnalystQuery[] = [];
  const client = {
    query: vi.fn<AnalystClient["query"]>((query) => {
      queries.push(query);
      try {
        return Promise.resolve({ fields: [], rows: [], ...respond(query) });
      } catch (error) {
        return Promise.reject(error);
      }
    }),
    release: vi.fn<AnalystClient["release"]>(),
  } satisfies AnalystClient;
  const connect = vi.fn(() => Promise.resolve<AnalystClient>(client));
  return { client, connect, queries };
};

/**
 * Builds an EXPLAIN (FORMAT JSON) result row.
 *
 * @param totalCost - Planner total cost.
 * @param extra - Additional plan node fields, such as `Output` expressions.
 * @returns A fake result whose single row carries the plan.
 */
export const explainResult = (
  totalCost: number,
  extra: { readonly [field: string]: JsonValue } = {}
): FakeResult => ({
  rows: [
    {
      "QUERY PLAN": [
        { Plan: { "Plan Rows": 10, "Total Cost": totalCost, ...extra } },
      ],
    },
  ],
});
