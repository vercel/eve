---
"eve": minor
---

The Braintrust reporter now logs each eval's token usage and cost as Braintrust metrics.

Rows include `prompt_tokens`, `completion_tokens`, `tokens`, `prompt_cached_tokens`, and `prompt_cache_creation_tokens` when the eval recorded usage, plus `estimated_cost` when every counted session reported a cost. Row metadata lists the eval's models under `eveModels` and each session's models and usage under `eveSessions`. `braintrustReporter` also accepts `metadata`, `tags`, `repoInfo`, and `cwd` options for the experiment.
