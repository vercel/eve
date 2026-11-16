---
description: Use before writing SQL for any business metric, such as MRR, ARR, customers, churn, revenue, refunds, trials, conversion, traffic, sessions, visitors, or signups.
---

# Metric definitions

These are the team's canonical definitions. Use them exactly. When a question uses a metric that isn't defined here, say which definition you assumed. If a user or channel memory describes a metric differently, use this file, say what differs, and suggest updating this file.

<!--
  TEMPLATE: this is the most important file to customize. The definitions below
  match the demo schema that `pnpm db:seed` creates. Replace them with your
  team's real definitions, table names, and exclusions. Keep the format: the
  name, a one-line definition, the exact SQL, and any time or filter rules.
  scripts/seed/sql.ts mirrors the MRR and traffic SQL for the seed summary and
  the evals; update it too.
-->

## Conventions

- Money is stored in USD cents. Divide by `100.0` and report dollars.
- The database session already runs in the reporting time zone, so `now()`, `current_date`, and `date_trunc` use it. Don't add `AT TIME ZONE`.
- Ranges are half-open: `ts >= start AND ts < end`.
- "Last month" is the previous full calendar month: `date_trunc('month', now()) - interval '1 month'` up to `date_trunc('month', now())`.
- "Last N days" is the N complete days before today: `ts >= current_date - N AND ts < current_date`. Say that today is excluded.
- "This month" or "month to date" runs from `date_trunc('month', now())` up to `now()`. Say the period is partial.
- Weeks start on Monday: `date_trunc('week', ts)`.

## Exclusions

- For customer, subscription, and revenue metrics, always exclude internal and test accounts: join `customers` and filter `NOT c.is_internal`. Traffic metrics don't need this join.
- Always exclude bot traffic: `NOT is_bot` on `web_sessions`.

## Recurring revenue

- **MRR at an instant T**: the sum of `mrr_cents` for subscriptions in service at T, in dollars.

  ```sql
  SELECT round(sum(s.mrr_cents) / 100.0, 2) AS mrr
  FROM subscriptions s
  JOIN customers c USING (customer_id)
  WHERE NOT c.is_internal
    AND s.started_at < :t
    AND (s.ended_at IS NULL OR s.ended_at >= :t)
  ```

- **MRR for a month** is MRR at the end of that month, which is the instant the next month starts. "MRR last month" uses `T = date_trunc('month', now())`. "Current MRR" uses `T = now()`.
- Never use `subscriptions.status` for history. It holds today's state only.
- **ARR**: MRR × 12.
- **Net new MRR for a month**: MRR at the end of the month minus MRR at its start.
- **MRR trend**: for each month, compute MRR at the end of that month (the instant the next month starts) with `generate_series` and a lateral or correlated sum, so every month appears and each point matches "MRR for a month".

## Customers

- **Paying customers at T**: distinct `customer_id` with a subscription in service at T (same conditions as MRR), excluding internal accounts. "Customers" alone means paying customers.
- **New paying customers in a period**: customers whose earliest `started_at` falls in the period.
- **Churned customers in month M**: paying at the start of M and not paying at the start of M + 1.
- **Logo churn rate for month M**: churned customers ÷ paying customers at the start of M.
- **Gross MRR churn rate for month M**: start-of-month MRR of churned customers ÷ total MRR at the start of M.
- **Trials started**: subscriptions with `trial_started_at` in the period.
- **Trial conversion rate**: of trials started in the cohort period, the share with `started_at IS NOT NULL`. Exclude trials whose `trial_ends_at` is after `now()`, since they haven't had the chance to convert.

## Cash revenue

- **Gross revenue**: `sum(amount_cents) / 100.0` from `payments` where `status = 'succeeded'`, bucketed by `payments.created_at`.
- **Refunds**: `sum(amount_cents) / 100.0` from `refunds`, bucketed by `refunds.created_at`.
- **Net revenue**: gross revenue minus refunds for the same period.
- Revenue is cash collected, so annual plans land in one month. MRR is the recurring run rate. Don't mix them, and say which one you report.

## Traffic

- **Sessions**: `count(*)` from `web_sessions`, excluding bots.
- **Visitors**: `count(DISTINCT anonymous_id)`, excluding bots.
- **Traffic source**: `web_sessions.source` (google, (direct), linkedin, newsletter, ...). **Channel**: `channel_group`. "Biggest traffic source" means the most sessions unless the question asks about signups or revenue.

  ```sql
  SELECT source, count(*) AS sessions
  FROM web_sessions
  WHERE NOT is_bot
    AND started_at >= current_date - 10
    AND started_at < current_date
  GROUP BY source
  ORDER BY sessions DESC
  ```

- **Signups**: `count(*)` from `signups`, attributed to a source by joining `web_sessions` on `session_id`.
- **Visit-to-signup conversion**: signups ÷ sessions for the same window and source.
