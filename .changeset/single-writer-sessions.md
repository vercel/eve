---
"eve": patch
---

One process writes an in-process session at a time, on Worlds with the in-band fence, internally.

A process that continues a session claims it first, and the World refuses the writes of the process that ran it before: none of its lines reach the stream, a tool it was about to run doesn't run, and its readers hear that the session continued elsewhere.
