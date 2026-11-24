---
"eve": minor
"@vercel/agent-runs": minor
---

Add `extract` to `eve/ai`, which reads typed fields such as invoice numbers, dates, and contact names from text, images, and PDFs with an extraction model like `scaledown/extract-1`, returning each value with its confidence and source.

`extract` uses the same model authentication as `decide`, including the `/login` Gateway connection during `eve dev`, and requires a `model`. Calls appear as `extraction <model>` OpenTelemetry spans with usage, cost, and, when outputs are recorded, `gen_ai.extraction.results`. `@vercel/agent-runs` adds `AgentRun.extraction` to record them.

eve's `ai` peer range starts at `7.0.176`, the first release with AI Gateway extraction models.
