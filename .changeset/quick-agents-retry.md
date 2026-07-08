---
"eve": patch
---

Retry transient provider overload errors delivered inside model streams. Classified transient failures get at most three fresh model-call attempts, while other recoverable task-mode errors fall back to Workflow's durable step retries without multiplying retry budgets.
