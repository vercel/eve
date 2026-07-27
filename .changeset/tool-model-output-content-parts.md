---
"eve": patch
---

`toModelOutput` can now return `{ type: "content", value }` with text and file parts, so a tool can send images (screenshots, rendered charts) to vision-capable models as actual pixels instead of descriptions. Build parts with the new `toolOutputPart.text` / `toolOutputPart.file` helpers from `eve/tools`; file payloads must be base64 strings.
