---
"eve": patch
---

Fixed a parent session recording the wrong approver for a subagent's approval when two people answered it before the subagent settled, or when the subagent's report named no answer the parent forwarded. The parent now credits the answer the subagent applied and leaves a row alone when it can't tell which one is meant.
