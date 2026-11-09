---
"eve": patch
---

Keep the head of a task result line that overflows the 50 KB budget instead of replacing it with `[truncated]`, so a one-line JSON result past the budget still reaches the model.

Thanks @nsxdavid for reporting this in #5746.
