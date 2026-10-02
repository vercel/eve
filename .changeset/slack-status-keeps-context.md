---
"eve": patch
---

The default Slack thread status no longer resets to `Thinking...` between model steps. It keeps naming the latest work, sets it again so Slack doesn't time it out, and shows it again after a new task card posts. It also shows a tool's progress and completion labels, the latest reasoning heading or sentence instead of the first line, `Writing a reply...` for long replies, and `+N more` for calls that stream in one step. While a turn waits on an approval, answer, or sign-in, the status is cleared.
