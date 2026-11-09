---
"eve": patch
---

Answer workflow tool calls from a model response that ended early (finish reason `length` or `other`) as not run, like other skipped calls, instead of starting their workflows without deciding their approval.
