---
"eve": patch
---

`toModelOutput` can now return `{ type: "content", value }` with text and file parts, so a tool can send images (screenshots, rendered charts) to vision-capable models as actual pixels instead of descriptions. Build outputs with the new `toolOutput.text` / `toolOutput.json` / `toolOutput.content` helpers and parts with `toolOutputPart.text` / `toolOutputPart.file`, all from `eve/tools`; file payloads must be base64 strings.
