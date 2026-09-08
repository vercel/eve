---
issue: https://github.com/vercel/eve/pull/3002
status: implemented
last_updated: "2026-09-08"
---

# Code Mode tool exposure

Code Mode uses on-demand discovery as its only execution policy; eager mode and the `mode` selector are removed.

Enable it with `experimental.codeMode: {}` or `{ maxSubagents: 25 }`.
Eligible tools are callable through the program; approval-gated tools and
framework controls remain direct. Programs retain their pinned catalog and
durable execution. Discovery lists names first and loads schemas on demand.

The previous eager policy exposed eligible tools both directly and through a
program, requiring the model to choose an execution path. Removing that choice
simplifies the public API and leaves the measured lazy behavior intact.

The [12-task benchmark](https://github.com/vercel-labs/eve-bench/blob/079fccb/research/code-mode-expansion/normal-eve-results.md)
found four faster lazy runs among five mutually successful direct/lazy pairs.
These are single trials on development tasks; grader defects and unverified
background completion prevent a clean overall ranking. Historical eager
measurements remain published. This API removal has not received a new paid run.

Unit and integration coverage checks eligible-tool hiding, direct approval
gates, discovery, catalog serialization and program suspension/resumption.
The scripted and real-model E2E fixtures now exercise the single policy.
