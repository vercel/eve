---
"eve": patch
---

Compaction no longer reproduces base64 file payloads from `content` tool outputs in the summarizer transcript. File parts are replaced with a text stub naming the file and media type (matching how message attachments are summarized); text parts still reach the checkpoint model raw.
