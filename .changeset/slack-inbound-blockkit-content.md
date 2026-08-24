---
"eve": patch
---

Slack inbound messages now derive their text from Block Kit blocks and legacy attachments when the top-level `text` field is empty or a short fallback. Alert-style bot posts (sections, fields, headers, markdown blocks, tables, rich text, legacy attachments) previously reached the model as an empty message body; they now carry the visible message content, and fetched thread replies get the same treatment.
