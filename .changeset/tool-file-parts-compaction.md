---
"eve": patch
---

Compaction no longer destroys tool-result file parts: token estimation caps file payloads at a fixed per-file cost instead of counting base64 length, and compaction summaries keep the text parts and stub file parts as filename+mediaType. Content tool outputs now reject empty file data and empty part arrays at validation time.
