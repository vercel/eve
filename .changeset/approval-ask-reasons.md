---
"eve": minor
---

Let an approval policy explain why it asks: `{ type: "user-approval", reason }` shows the reason after the call's approval prompt.

An agent-wide policy's reason is kept when the tool's own approval also asks, including its `once()` memory.
