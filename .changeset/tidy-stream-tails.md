---
"eve": patch
---

Include the current continuation token in `session.waiting` events, and allow negative stream start indexes such as `-1` to read relative to the current tail.
