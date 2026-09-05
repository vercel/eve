---
issue: https://github.com/vercel/eve/pull/3002
status: implemented
last_updated: "2026-09-04"
---

# Code Mode selection

Eager mode exposes direct tools alongside `code_mode` so the model can choose a program when the work benefits from one.

Previously both eager and lazy hid eligible direct tools. Selection guidance
could not offer a direct call for a single lookup. Eager now preserves those
tools and their existing executors, while retaining the same program catalog
and durable execution. Lazy keeps its discovery-only exposure. Approval-gated
tools remain direct-only.

The guidance prefers programs for dependent lookups, pagination, loops, and
filtering or aggregation. It prefers direct calls when one call or a native
batch already produces the needed result. Neither path is the universal default.
Programs should reuse fetched data and avoid duplicate computation.

The [54-attempt pilot](https://github.com/ruiconti/shower/blob/b1f122ce6f09ba426918594bebc00d491b16dce6/research/benchmark/jobs/d0-golden-controls/task-shapes-pilot-20260904/REPORT.md)
supports testing this policy, not a universal fanout threshold. Eager still
includes schemas up front; this change does not avoid that metadata cost.

Unit coverage checks both surfaces, executor identity, the pinned catalog, and
approval exclusions. Deterministic fixture evals cover direct completion and
program execution. They verify availability, not whether a real model chooses
the faster or cheaper path; that requires a matched conditional-policy run.
