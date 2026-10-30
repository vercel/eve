---
"eve": patch
---

Channel route `params` now keep encoded path separators (`%2F` and `%5C`) encoded, so a param can no longer contain a `/` or `\` that the request path never had.

Other percent-encoded characters are still decoded, so `/files/caf%C3%A9` gives `café`. A handler that expected `%2F` decoded to `/` must now decode it itself. A request whose path params have malformed percent-encoding gets `400 Bad Request` before any route handler runs.
