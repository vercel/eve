/**
 * Expected answers computed live from the seeded demo database, so evals stay correct as the data ages.
 *
 * @packageDocumentation
 */
import { z } from "zod";

import { analystConfig } from "#lib/analyst/config";
import { DEMO_SCHEMA } from "#lib/analyst/derived-login";
import { closePool, runReadOnlySql } from "#lib/analyst/postgres";
import { mrrLastMonthSql, topSourcesLast10DaysSql } from "#scripts/seed/sql";

/** Expected values for the metric evals. */
export interface GroundTruth {
  /** First day of last month, `YYYY-MM-DD`. */
  readonly lastMonthStart: string;
  /** MRR at the end of last month, in dollars. */
  readonly mrrLastMonth: number;
  /** Source with the most non-bot sessions over the 10 complete days before today. */
  readonly topSourceLast10Days: string;
}

/**
 * Picks the schema that holds the demo data.
 *
 * @param schemas - Configured `ANALYST_SCHEMAS`, in order.
 * @returns The demo schema when it's listed, otherwise the first schema, for data seeded with `pnpm db:seed --schema`.
 */
export const demoSchema = (schemas: readonly string[]): string =>
  schemas.includes(DEMO_SCHEMA) ? DEMO_SCHEMA : (schemas[0] ?? DEMO_SCHEMA);

/**
 * Runs the canonical demo queries as the default analyst role.
 *
 * @returns Expected answers in the reporting time zone.
 * @remarks Queries the demo schema when `ANALYST_SCHEMAS` lists it, otherwise the first listed schema. Mirrors agent/skills/metric-definitions.md through scripts/seed/sql.ts; keep all three in sync.
 */
export const computeGroundTruth = async (): Promise<GroundTruth> => {
  const config = analystConfig();
  const role = config.ANALYST_DEFAULT_ROLE || "analyst_readonly";
  const schema = demoSchema(config.ANALYST_SCHEMAS);
  try {
    const mrr = await runReadOnlySql(mrrLastMonthSql(schema), role);
    const sources = await runReadOnlySql(topSourcesLast10DaysSql(schema), role);
    const [monthStart, amount] = z
      .tuple([z.string(), z.coerce.number()])
      .parse(mrr.rows[0]);
    const [source] = z.tuple([z.string(), z.number()]).parse(sources.rows[0]);
    return {
      lastMonthStart: monthStart,
      mrrLastMonth: amount,
      topSourceLast10Days: source,
    };
  } finally {
    await closePool();
  }
};

/**
 * Checks whether text mentions a dollar amount within a relative tolerance of the expected value.
 *
 * @param text - Assistant message.
 * @param expected - Expected amount in dollars.
 * @param tolerance - Allowed relative difference, such as 0.005 for 0.5%.
 * @returns Whether any amount in the text, including forms like $180.5k, is close enough.
 */
export const mentionsAmountNear = (
  text: string,
  expected: number,
  tolerance: number
): boolean => {
  const amounts = [
    ...text.matchAll(/\$\s?(?<value>\d[\d,]*(?:\.\d+)?)\s?(?<unit>[kKmM])?/gu),
  ].map((match) => {
    const value = Number(match.groups?.value?.replaceAll(",", ""));
    const unit = match.groups?.unit?.toLowerCase();
    if (unit === "k") {
      return value * 1000;
    }
    return unit === "m" ? value * 1_000_000 : value;
  });
  return amounts.some(
    (amount) => Math.abs(amount - expected) <= expected * tolerance
  );
};
