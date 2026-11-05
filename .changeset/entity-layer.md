---
"eve": patch
---

A World host's sessions are now durable entities, behind one internal interface that a native implementation in Workflow could replace.

Each activation reads only what arrived since the last one and none of the session's stream, consumes a message in the same write as the input that keeps it, and sleeps through an early alarm without restoring the session. Messages and approvals work on Vercel's World, and a session waiting on `ask_question` goes on after a restore. The memory and IndexedDB Worlds now take one write to a run at a time.
