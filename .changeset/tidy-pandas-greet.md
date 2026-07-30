---
"eve": patch
---

Splits token usage on local trace spans: model and step spans now record `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` (OTel GenAI semantic-convention names) alongside the input/output totals when the provider reports detailed usage — cached tokens price differently, so the split makes cost attribution exact. Providers without detailed usage emit only the totals.
