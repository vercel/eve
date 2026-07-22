---
"eve": patch
---

Report `connection_search` as failed when every targeted connection fails to load, including authorization startup failures, so tool-call observability preserves the underlying error. Requests for unregistered connections now fail instead of returning an empty result.
