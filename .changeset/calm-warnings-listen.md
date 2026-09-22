---
"eve": patch
---

Route AI SDK provider warnings to eve's diagnostics instead of presenting successful compatibility fallbacks as stderr errors. Existing custom warning handlers and `AI_SDK_LOG_WARNINGS=false` remain respected.
