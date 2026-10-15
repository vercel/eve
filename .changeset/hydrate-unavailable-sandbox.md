---
"eve": patch
---

Attachments no longer fail a step when the session's sandbox cannot be resumed, for example when a follow-up lands on another replica. Earlier attachments and tool-result files in history reach the model as a "FileNotFound" note, and new inbound attachments and tool-returned files become a "could not be stored" note. Tools that use the sandbox still report the resume error.
