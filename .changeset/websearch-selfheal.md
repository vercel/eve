---
"eve": patch
---

Agents on OpenAI-compatible endpoints without native web search (e.g. Bedrock Mantle) no longer hard-fail every turn when the framework auto-injects a web-search tool. The endpoint's rejection is now recognized, so the harness drops `web_search` and retries the step instead of failing terminally.
