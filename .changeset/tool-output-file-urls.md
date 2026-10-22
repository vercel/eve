---
"eve": patch
---

Tools can now hand the model a file by URL. `toolOutputPart.fileUrl(url, { mediaType })` from `eve/tools` returns a `{ type: "file", data: { type: "url", url } }` content part from `toModelOutput`, so a large file such as a presigned PDF link reaches the model without being base64-encoded, staged into the sandbox, or stored in session history. Only `https:` URLs are accepted, and the URL must stay readable for the rest of the session because every later model call sends it again.
