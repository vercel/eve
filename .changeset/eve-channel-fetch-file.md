---
"eve": patch
---

`eveChannel()` accepts `fetchFile`, so a web client can upload a large file to its own storage and send only the URL. eve loads the file inside the workflow step, past the platform's request body limit, and holds the fetched bytes to the channel's `uploadPolicy`. A file over the cap or of a disallowed type reaches the model as a note.
