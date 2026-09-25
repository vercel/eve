---
"eve": minor
---

Simplify the CLI around explicit local and remote agent workflows. Use `eve remote` to connect to, invoke, or inspect an existing agent; `eve dev` now starts only local development.

Replace `eve dev <url>` with `eve remote connect <url>`, and `eve invoke` with `eve remote invoke <url>`. Replace `eve set --model` and `eve set --reasoning` with `eve set model [model] [--reasoning <effort>]`.
