---
"eve": patch
---

`eveChannel()` accepts `fetchFile`, so a web client can upload a large file to its own storage and send only the URL. eve loads the file inside the workflow step, past the platform's request body limit. `defineChannel` and `eveChannel` take an `uploadPolicy` that eve now applies to every staged file, including URLs it downloads itself, on the final bytes and their verified media type. Slack, Telegram, and Teams apply their own `uploadPolicy` the same way. A file over the cap or of a disallowed type reaches the model as a note. An `eveChannel` with `uploadPolicy` or `fetchFile` reports its instrumentation kind as `channel:eve` instead of `http`, as one with `events` already does.
