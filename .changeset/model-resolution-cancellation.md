---
"eve": patch
---

A turn cancellation raised while the model is being resolved now cancels the turn instead of failing the session with `MODEL_SELECTION_FAILED`, even when it arrives before the turn's abort signal fires.

Thanks @burn2delete for reporting this and proposing the fix in #4273.
