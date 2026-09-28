---
"eve": patch
---

The Datadog reporter now shares eval prompts, outputs, expected outputs, assertion details, and error messages by default, matching the Braintrust reporter; pass `recordInputs: false` (or the matching `record*` option) to opt out. Inputs are synced into one reused dataset (`<projectName> evals` by default), keyed by eval description, so Datadog can compare experiments row by row.
