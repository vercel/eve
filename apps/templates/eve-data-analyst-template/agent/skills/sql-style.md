---
description: Use when writing non-trivial Postgres SQL, such as time series, cohorts, retention, funnels, rankings, or period-over-period comparisons.
---

# Postgres SQL patterns

- Aggregate in the database. Return summaries, not raw rows; results are capped and long cells are cut.
- Never `SELECT *` from large tables. Name the columns you need.
- Always bound large fact tables (`web_sessions`, `payments`, `invoices`) by time. Unbounded scans can trigger an approval prompt.
- The session time zone is already the reporting time zone. Use `date_trunc`, `current_date`, and `now()` directly.
- Use CTEs to keep multi-step logic readable.
- Build complete time series with `generate_series` and a left join, so empty periods show as zero instead of disappearing.
- Period over period: compute each period in a CTE and join, or use `lag(value) OVER (ORDER BY period)`.
- Cohorts: assign each customer a cohort with `min(date_trunc('month', started_at))`, then count activity by months since the cohort.
- Use `count(DISTINCT ...)` for people and `count(*)` for events, and say which.
- Use `FILTER (WHERE ...)` for several conditional counts in one pass.
- Divide with `100.0` or `::numeric` to avoid integer division, and wrap denominators in `nullif(x, 0)`.
- Round only in the final SELECT.
- For top-N questions, `ORDER BY ... DESC LIMIT n` and say how many were left out if it matters.
- Keep results chart-ready when a chart is likely: one row per category or period, at most 20 of them.
