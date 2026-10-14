---
"eve": patch
---

Let a message sent with `turnPolicy: "queue"` right after a tool approval or sign-in appears steer the held turn again. A message that arrived while the step raising the request was still finishing was treated as sent before the request, so it stayed queued behind a turn that could not end until the person acted.
