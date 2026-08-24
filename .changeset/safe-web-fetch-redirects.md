---
"eve": patch
---

Follow up to ten `web_fetch` redirects while rechecking each destination for SSRF safety. Non-success HTTP responses now return a plain-text failure result with the response body when available instead of failing the tool call.
