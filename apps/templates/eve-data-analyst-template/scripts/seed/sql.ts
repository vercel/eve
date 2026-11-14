/**
 * Canonical demo queries shared by the seed summary and eval ground truth.
 *
 * @packageDocumentation
 */

/**
 * MRR at the start of the current month (the end of last month), excluding internal accounts.
 *
 * @param schema - Validated schema name.
 * @returns SQL returning one row: `month_start` (last month's first day) and `mrr` in dollars.
 * @remarks Mirrors the MRR definition in agent/skills/metric-definitions.md; keep them in sync.
 */
export const mrrLastMonthSql = (schema: string): string => `
  SELECT to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM-DD') AS month_start,
         round(sum(s.mrr_cents) / 100.0, 2)::text AS mrr
  FROM ${schema}.subscriptions s
  JOIN ${schema}.customers c USING (customer_id)
  WHERE NOT c.is_internal
    AND s.started_at < date_trunc('month', now())
    AND (s.ended_at IS NULL OR s.ended_at >= date_trunc('month', now()))`;

/**
 * Sessions by source over the 10 complete days before today, excluding bots.
 *
 * @param schema - Validated schema name.
 * @returns SQL returning `source` and `sessions`, largest first.
 * @remarks Mirrors the traffic definitions in agent/skills/metric-definitions.md; keep them in sync.
 */
export const topSourcesLast10DaysSql = (schema: string): string => `
  SELECT source, count(*)::int AS sessions
  FROM ${schema}.web_sessions
  WHERE NOT is_bot
    AND started_at >= current_date - 10
    AND started_at < current_date
  GROUP BY source
  ORDER BY sessions DESC
  LIMIT 5`;
