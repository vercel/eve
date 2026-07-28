---
"eve": patch
---

Compaction no longer reproduces base64 file payloads from `content` tool outputs. In the summarizer transcript and in capped kept-history results alike, file parts are replaced with a text stub naming the file and media type (matching how message attachments are summarized); sibling text parts survive instead of being truncated away behind the serialized payload.
