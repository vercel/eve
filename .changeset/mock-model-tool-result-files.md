---
"eve": patch
---

`mockModel` responders see tool-result files again as `{ type: "file", data: { type: "data", data } }` parts in `toolResults[].output`. Since `ai@7.0.116`, they had received legacy `file-data` parts, so a scripted model that looked for an image from `toModelOutput` could miss it and keep calling the tool.
