---
"eve": patch
---

Preserve one observability conversation ID across local and remote agent dispatch, accepting incoming correlation only on callback-marked remote session creation. Apply the live delivery's trace-content ceiling to the selected caller context, including fallback when its action span is unavailable.
