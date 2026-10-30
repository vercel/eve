---
"eve": patch
---

Teams approval and question cards now show the prompt, tool input, and answer as literal text.

A model-written `[docs](https://evil.example)` no longer renders as a link whose label hides its destination. The cards use `RichTextBlock` text runs, and the message text is sent as plain text.
