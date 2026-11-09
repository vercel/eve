---
"eve": patch
---

A channel route whose path ends in a file extension, such as `/.well-known/agent-card.json` or `/robots.txt`, now builds and serves its handler.

Thanks @mattcreager for reporting this and tracing it to the route module ids in #5742.
