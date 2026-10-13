---
"eve": patch
---

`eve/client` now sends a file part's bytes as a `data:` URL. Before, a `Uint8Array` or `ArrayBuffer` in a message serialized as an object, and the route refused the request.
