---
"eve": patch
---

Recover automatically when an OpenAI-compatible endpoint (e.g. AWS Bedrock Mantle) rejects the injected provider-managed `web_search` tool. The harness now recognizes the `web_search_call.action.sources` include rejection, drops `web_search`, and retries the step, so agents on such endpoints complete turns instead of failing every model call.
