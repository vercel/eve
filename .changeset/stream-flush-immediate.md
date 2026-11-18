---
"eve": patch
---

On Vercel, the first stream line of each reply now reaches the client up to 10 ms sooner, because eve no longer holds it in a 10 ms flush window.

eve now uses the Workflow SDK default, which sends the first chunk of an idle stream at once and batches the chunks that arrive while a write is in flight. To get the old window back, set `WORKFLOW_STREAM_FLUSH_INTERVAL_MS=10`.
