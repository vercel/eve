---
"eve": patch
---

Custom channels can answer pending approvals and questions from typed text, as eve's own channels do.

Pass `answerText` to `send()` when the model reads a wrapped message, such as one with a speaker prefix, and show the request a reply answers with `nextPrompt(view)` from `eve/events`.
