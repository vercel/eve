---
"eve": minor
---

The Braintrust reporter now logs each eval's token usage and cost as Braintrust metrics.

Rows include `prompt_tokens`, `completion_tokens`, `tokens`, `prompt_cached_tokens`, `prompt_cache_creation_tokens`, and `estimated_cost` when the eval recorded usage, and list models and per-session usage in metadata. `braintrustReporter` also accepts `metadata`, `tags`, `repoInfo`, and `cwd` options for the experiment.
