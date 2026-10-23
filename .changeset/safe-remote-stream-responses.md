---
"eve": patch
---

Remote session stream proxies now reject unexpected response types and enforce non-executable MIME types with `nosniff`, including upstream errors. Unexpected error content types produce generic JSON without changing the upstream error status.
